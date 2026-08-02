import { atom } from "jotai";
import { getClientLogger } from "#src/lib/logger";
import { queryClient } from "#src/lib/query-client";
import type { SavedWorkflow } from "#src/lib/rpc-client";
import { workflowApi } from "#src/lib/rpc-client";
import { orpcQuery } from "#src/lib/rpc-query";
import type {
  WorkflowEdge,
  WorkflowMode,
  WorkflowNode,
  WorkflowVisibility,
} from "#src/lib/workflow-graph-types";

/**
 * Identity of the workflow open in the editor, and the single path by which it
 * gets written back.
 *
 * Every write to the open workflow goes through `saveWorkflowAtom`. That is the
 * point of this module: saving from nine places with no shared knowledge of
 * each other's pending debounce would let an explicit save be undone by a
 * debounced one landing a second later.
 *
 * This module deliberately knows nothing about the graph cells. It queues
 * patches; `workflow-graph-store` is what decides a patch is due. Keeping the
 * dependency one-way is what stops the two concerns from growing back together.
 */

// Which workflow the editor currently has open.
const logger = getClientLogger("workflow", "save");

export const currentWorkflowIdAtom = atom<string | null>(null);
export const currentWorkflowNameAtom = atom<string>("");
export const currentWorkflowVisibilityAtom =
  atom<WorkflowVisibility>("private");
export const currentWorkflowModeAtom = atom<WorkflowMode>("live");
export const isWorkflowOwnerAtom = atom<boolean>(true);
export const workflowNameErrorAtom = atom<string | null>(null);
export const workflowNotFoundAtom = atom(false);

// Save status, read by the toolbar and the unsaved-changes indicator.
export const isSavingAtom = atom(false);
export const hasUnsavedChangesAtom = atom(false);

/**
 * The last save failure, or null after a save succeeds.
 *
 * A debounced save has no caller waiting on it, so without this a failed
 * autosave would only ever reach the console while the UI kept claiming the
 * workflow was saved.
 */
export const lastSaveErrorAtom = atom<Error | null>(null);

/**
 * The subset of the workflow API this module calls, as an atom so a test can
 * substitute it per store rather than reassigning the shared client singleton.
 */
type WorkflowSaveApi = Pick<typeof workflowApi, "create" | "update">;
export const workflowApiAtom = atom<WorkflowSaveApi>(workflowApi);

/**
 * A saved name, mode, or graph makes the dashboard's list wrong, and the
 * dashboard is never mounted when this fires.
 *
 * Marked stale rather than refetched: the editor's own switcher observes this
 * entry, so refetching would mean a request per debounce window while the user
 * types. The dashboard refetches on its next mount instead. This module runs
 * outside React, which is why it reaches for the client singleton the router's
 * loaders already use.
 */
function markWorkflowListStale() {
  void queryClient.invalidateQueries({
    queryKey: orpcQuery.workflow.getAll.key(),
    refetchType: "none",
  });
}

/** Debounce window for typing-driven saves. Tests set this to 0. */
export const autosaveDelayAtom = atom(1000);

/**
 * The fields one `update` call can carry. A later patch wins field by field.
 *
 * Nodes and edges travel together because the server takes one serialized graph:
 * sending half of it would drop the other half. The union makes that a type
 * error rather than something the queue has to check for at run time.
 */
export type WorkflowPatch = { name?: string; mode?: WorkflowMode } & (
  | { nodes: WorkflowNode[]; edges: WorkflowEdge[] }
  | { nodes?: undefined; edges?: undefined }
);

/**
 * What a caller gets back. Saves never reject: a debounced save has no `await`
 * behind it, and a rejection nothing handles is an unhandled rejection. Callers
 * that need to report a failure read it off the resolved value instead.
 */
export type SaveOutcome =
  | { ok: true; workflow: SavedWorkflow }
  | { ok: false; error: Error };

type PendingSave = {
  workflowId: string;
  patch: WorkflowPatch;
  /** Resolved once the `update` carrying this patch comes back. */
  waiters: Array<(outcome: SaveOutcome) => void>;
};

type SaveQueue = {
  timeoutId: ReturnType<typeof setTimeout> | null;
  /**
   * Oldest first. A queue rather than a single slot because navigating away
   * from a workflow with an edit still pending must send that edit, not drop
   * it — and dropping it would also strand everyone awaiting it.
   */
  pending: PendingSave[];
  isFlushing: boolean;
};

/**
 * Queue bookkeeping, held in an atom for one reason: this state has to live at
 * the same scope as the state it guards. Three module-level `let`s would let
 * two jotai stores share one debounce timer, so each could cancel the other's
 * pending save.
 *
 * It has to be a *derived* atom, not `atom(initialValue)`: a primitive atom's
 * initial value is one object shared by every store, which would reintroduce
 * exactly the sharing this is here to remove. A derived atom runs its body once
 * per store, so each store gets its own queue.
 *
 * The read function must stay dependency-free. Calling `get` inside it would
 * give the atom a dependency, and the queue would then be rebuilt whenever that
 * dependency changed — resetting `isFlushing` mid-flight and orphaning a timer.
 *
 * The object is mutated in place rather than `set`, because nothing renders
 * from it and a re-render per keystroke would be pure waste.
 */
const saveQueueAtom = atom(
  (): SaveQueue => ({ timeoutId: null, pending: [], isFlushing: false })
);

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Failed to save workflow", { cause: error });
}

/**
 * Drop the `add` placeholder before the graph goes over the wire.
 *
 * `add` is a UI-only node the canvas shows before a workflow has its first real
 * step. The toolbar's save always filtered it out and autosave never did, so
 * whether a placeholder got persisted depended on which save fired. Filtering
 * here is what makes that answer the same for every caller.
 */
function toUpdatePayload(patch: WorkflowPatch) {
  const { nodes, edges, ...metadata } = patch;

  if (!(nodes && edges)) {
    return metadata;
  }

  return {
    ...metadata,
    nodes: nodes.filter((node) => node.type !== "add"),
    edges,
  };
}

/**
 * Queue a patch against the open workflow.
 *
 * `immediate` skips the debounce and waits for the write; otherwise the patch
 * sits for `autosaveDelayAtom` so a burst of keystrokes becomes one request.
 * The drain is single-flight and sequential, because two overlapping `update`
 * calls for one workflow can land out of order and the loser silently wins.
 */
export const saveWorkflowAtom = atom(
  null,
  async (
    get,
    set,
    patch: WorkflowPatch,
    options?: { immediate?: boolean }
  ): Promise<SaveOutcome | null> => {
    // The edit is unsaved from the moment it is queued, whether or not there is
    // a workflow to send it to yet.
    set(hasUnsavedChangesAtom, true);

    const workflowId = get(currentWorkflowIdAtom);
    if (!workflowId) {
      return null;
    }

    const queue = get(saveQueueAtom);

    const flush = async (): Promise<void> => {
      if (queue.isFlushing) {
        return;
      }
      queue.isFlushing = true;
      set(isSavingAtom, true);

      try {
        while (queue.pending.length > 0) {
          const next = queue.pending.shift();
          if (!next) {
            break;
          }

          let outcome: SaveOutcome;
          try {
            // eslint-disable-next-line no-await-in-loop -- saves must remain sequential to preserve latest-write semantics.
            const workflow = await get(workflowApiAtom).update(
              next.workflowId,
              toUpdatePayload(next.patch)
            );
            outcome = { ok: true, workflow };
            set(lastSaveErrorAtom, null);
            markWorkflowListStale();

            // Clear the dirty flag only when nothing newer is queued and the
            // saved workflow is still the one on screen.
            if (
              queue.pending.length === 0 &&
              get(currentWorkflowIdAtom) === next.workflowId
            ) {
              set(hasUnsavedChangesAtom, false);
            }
          } catch (error) {
            const saveError = toError(error);
            outcome = { ok: false, error: saveError };
            set(lastSaveErrorAtom, saveError);
            logger.error("Save failed", {
              workflowId: next.workflowId,
              error,
            });
          }

          for (const resolve of next.waiters) {
            resolve(outcome);
          }
        }
      } finally {
        queue.isFlushing = false;
        set(isSavingAtom, false);
      }
    };

    const outcome = new Promise<SaveOutcome>((resolve) => {
      // Merge only into the newest entry, and only when it targets the same
      // workflow, so a rename typed during a node drag becomes one request
      // carrying both. An entry for a different workflow stays queued behind it.
      const newest = queue.pending.at(-1);
      if (newest?.workflowId === workflowId) {
        newest.patch = { ...newest.patch, ...patch };
        newest.waiters.push(resolve);
        return;
      }

      queue.pending.push({ workflowId, patch, waiters: [resolve] });
    });

    if (queue.timeoutId) {
      clearTimeout(queue.timeoutId);
      queue.timeoutId = null;
    }

    if (options?.immediate) {
      await flush();
      return await outcome;
    }

    queue.timeoutId = setTimeout(() => {
      queue.timeoutId = null;
      flush().catch((error) => {
        logger.error("Save flush failed", { error });
      });
    }, get(autosaveDelayAtom));

    return await outcome;
  }
);

/**
 * Persist a rename. Debounced, so holding a key down is still one request.
 *
 * Resolves with the failure, or null when the rename landed. Callers only ever
 * want the message, so the saved workflow is not worth handing back.
 */
export const renameWorkflowAtom = atom(
  null,
  async (_get, set, name: string): Promise<Error | null> => {
    set(currentWorkflowNameAtom, name);
    set(workflowNameErrorAtom, null);
    const outcome = await set(saveWorkflowAtom, { name });
    return outcome?.ok === false ? outcome.error : null;
  }
);

/** Switch Live/Test. Immediate, because the UI reports the result straight away. */
export const setWorkflowModeAtom = atom(
  null,
  async (_get, set, mode: WorkflowMode): Promise<SaveOutcome | null> =>
    await set(saveWorkflowAtom, { mode }, { immediate: true })
);

/**
 * Create the workflow the editor has been drafting.
 *
 * Separate from the queue because there is no workflow id to key a patch on
 * yet; the queue only ever updates a workflow that already exists.
 */
export const createWorkflowAtom = atom(
  null,
  async (
    get,
    set,
    input: {
      name: string;
      description?: string;
      nodes: WorkflowNode[];
      edges: WorkflowEdge[];
    }
  ): Promise<SaveOutcome> => {
    try {
      const workflow = await get(workflowApiAtom).create({
        name: input.name,
        description: input.description ?? "",
        nodes: input.nodes.filter((node) => node.type !== "add"),
        edges: input.edges,
      });
      // The draft is now a real workflow, so this module adopts it. Leaving
      // that to the caller is how identity and the dirty flag drift apart.
      set(currentWorkflowIdAtom, workflow.id);
      set(currentWorkflowNameAtom, workflow.name);
      set(workflowNameErrorAtom, null);
      set(hasUnsavedChangesAtom, false);
      set(lastSaveErrorAtom, null);
      markWorkflowListStale();
      return { ok: true, workflow };
    } catch (error) {
      const saveError = toError(error);
      set(lastSaveErrorAtom, saveError);
      return { ok: false, error: saveError };
    }
  }
);
