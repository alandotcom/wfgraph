import { atom } from "jotai";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { getClientLogger } from "#src/lib/logger";
import { queryClient } from "#src/lib/query-client";
import type { SavedWorkflow } from "#src/lib/rpc-client";
import { workflowApi } from "#src/lib/rpc-client";
import { cacheWorkflowPublication, orpcQuery } from "#src/lib/rpc-query";
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
export const workflowNotFoundAtom = atom(false);
export const workflowLoadErrorAtom = atom<string | null>(null);

// Save status, read by the toolbar and the unsaved-changes indicator.
export const isSavingAtom = atom(false);
export const hasUnsavedChangesAtom = atom(false);

/**
 * When the last write landed, or null before the first one of the session.
 *
 * The status strip says "Saved 14:32" rather than "Saved", because a workflow
 * left open all afternoon says "Saved" whether the last edit went out a second
 * ago or was dropped an hour ago. Written only where a save succeeds, so a
 * failure leaves the previous time standing beside the failure wording.
 */
export const lastSavedAtAtom = atom<Date | null>(null);

/**
 * The last save failure, or null after a save succeeds.
 *
 * A debounced save has no caller waiting on it, so without this a failed
 * autosave would only ever reach the console while the UI kept claiming the
 * workflow was saved.
 */
export const lastSaveErrorAtom = atom<Error | null>(null);

/**
 * Successful writes completed for each workflow during this editor lifetime.
 * A route loader captures the current number when it starts; hydration compares
 * that snapshot with the current number before replacing the graph. The map is
 * replaced on every write so stores remain independent and derived reads see
 * each completed save.
 */
export const successfulSaveGenerationAtom = atom(new Map<string, number>());

/**
 * The subset of the workflow API this module calls, as an atom so a test can
 * substitute it per store rather than reassigning the shared client singleton.
 */
type WorkflowSaveApi = Pick<typeof workflowApi, "update">;
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
export type WorkflowPatch = {
  name?: string | undefined;
  mode?: WorkflowMode | undefined;
} & (
  | { nodes: WorkflowNode[]; edges: WorkflowEdge[] }
  | { nodes?: undefined; edges?: undefined }
);

/**
 * Fold an earlier patch under a later one, field by field, with the later
 * patch winning. `nodes` and `edges` travel together, so a graph is taken whole
 * from whichever patch carries one rather than merged key by key.
 */
function mergePatches(
  earlier: WorkflowPatch,
  later: WorkflowPatch
): WorkflowPatch {
  // A field neither patch carries stays absent, because `toUpdatePayload` sends
  // every key the patch holds and the contract reads an absent key as "leave
  // this alone".
  const metadata = omitUndefined({
    name: later.name ?? earlier.name,
    mode: later.mode ?? earlier.mode,
  });
  const graph = later.nodes ? later : earlier;
  return graph.nodes
    ? { ...metadata, nodes: graph.nodes, edges: graph.edges }
    : metadata;
}

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
  /**
   * Fields a failed request did not persist, kept per workflow until another
   * save for that workflow can carry them. Without this, a later partial save
   * (for example a rename after a graph write) can succeed and make the editor
   * look clean while the failed graph fields are still absent on the server.
   */
  failedPatches: Map<string, WorkflowPatch>;
  /** Rename state shared by overlapping callers until the last one settles. */
  renames: Map<
    string,
    {
      activeCount: number;
      latestRequestId: number;
      confirmedName: string;
    }
  >;
  nextRenameRequestId: number;
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
const saveQueueAtom = atom((): SaveQueue => ({
  timeoutId: null,
  pending: [],
  failedPatches: new Map(),
  renames: new Map(),
  nextRenameRequestId: 0,
  isFlushing: false,
}));

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
    // A newer edit retires the last failure: the write that failed is not the
    // one the editor is now holding. Without this the failure never clears --
    // the dirty flag is not lowered on the failure path -- and the status
    // readout could never reach "Save failed", because a failed save always
    // leaves something unsaved to report instead.
    set(lastSaveErrorAtom, null);

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
            const saveGenerations = get(successfulSaveGenerationAtom);
            set(
              successfulSaveGenerationAtom,
              new Map(saveGenerations).set(
                next.workflowId,
                (saveGenerations.get(next.workflowId) ?? 0) + 1
              )
            );
            const rename = queue.renames.get(next.workflowId);
            if (rename) {
              rename.confirmedName = workflow.name;
            }
            set(lastSaveErrorAtom, null);
            markWorkflowListStale();
            cacheWorkflowPublication(queryClient, workflow);

            // The queue drains workflows the editor may already have left, so
            // the clock reading is only true of the workflow on screen. Written
            // under the same guard as the dirty flag below: without it, saving
            // A at 12:04 and then opening B had B's strip claiming a write that
            // never happened to it.
            if (get(currentWorkflowIdAtom) === next.workflowId) {
              set(lastSavedAtAtom, new Date());
            }

            // Clear the dirty flag only when nothing newer is queued and the
            // saved workflow is still the one on screen.
            if (
              !queue.pending.some(
                (pending) => pending.workflowId === next.workflowId
              ) &&
              !queue.failedPatches.has(next.workflowId) &&
              get(currentWorkflowIdAtom) === next.workflowId
            ) {
              set(hasUnsavedChangesAtom, false);
            }
          } catch (error) {
            const saveError = toError(error);
            outcome = { ok: false, error: saveError };
            set(lastSaveErrorAtom, saveError);

            // A later partial patch must not make this failed one disappear.
            // Fold it into the next queued write for the same workflow when
            // there is one; otherwise remember it until that workflow is
            // edited again. The later patch wins field by field.
            const later = queue.pending.find(
              (pending) => pending.workflowId === next.workflowId
            );
            if (later) {
              later.patch = mergePatches(next.patch, later.patch);
            } else {
              queue.failedPatches.set(
                next.workflowId,
                mergePatches(
                  queue.failedPatches.get(next.workflowId) ?? {},
                  next.patch
                )
              );
            }
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
      const failedPatch = queue.failedPatches.get(workflowId);
      const patchWithRetry = failedPatch
        ? mergePatches(failedPatch, patch)
        : patch;
      queue.failedPatches.delete(workflowId);

      const newest = queue.pending.at(-1);
      if (newest?.workflowId === workflowId) {
        newest.patch = mergePatches(newest.patch, patchWithRetry);
        newest.waiters.push(resolve);
        return;
      }

      queue.pending.push({
        workflowId,
        patch: patchWithRetry,
        waiters: [resolve],
      });
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
 * Take a name the server refused back out of the queue.
 *
 * The queue retries a failed patch by folding it into the next write for the
 * same workflow, which is right for a dropped connection and wrong for a name
 * the server will never accept: the refused name rides along with every later
 * graph write and fails that too, so one rejected rename stops the editor
 * saving anything for the rest of the session. Only the exact name that was
 * refused is dropped, so a rename typed again while this one was in flight
 * survives.
 */
function forgetRefusedName(
  queue: SaveQueue,
  workflowId: string,
  refusedName: string
) {
  const parked = queue.failedPatches.get(workflowId);
  // Only the exact name that was refused is dropped, so a rename typed again
  // while this one was in flight survives. The parked patch is the only place
  // to look: an immediate save resolves once the whole queue has drained, so
  // there is nothing still pending by the time this runs.
  if (parked?.name !== refusedName) {
    return;
  }

  const { name: _refused, ...remaining } = parked;
  if (Object.keys(remaining).length === 0) {
    queue.failedPatches.delete(workflowId);
  } else {
    queue.failedPatches.set(workflowId, remaining);
  }
}

/**
 * Persist a rename, and put the old name back if the server refuses the new one.
 *
 * Immediate, because a caller is waiting on the answer: the dialog this comes
 * from refuses to close until it settles, and a debounce would hold that dialog
 * shut for the whole autosave window.
 *
 * Resolves with the failure, or null when the rename landed. Callers only ever
 * want the message, so the saved workflow is not worth handing back. On a
 * failure nothing of the rename is left standing anywhere: not on the name the
 * editor renders, and not in the queue.
 */
export const renameWorkflowAtom = atom(
  null,
  async (get, set, name: string): Promise<Error | null> => {
    const previousName = get(currentWorkflowNameAtom);
    const workflowId = get(currentWorkflowIdAtom);
    const queue = get(saveQueueAtom);
    const requestId = ++queue.nextRenameRequestId;
    let rename = workflowId ? queue.renames.get(workflowId) : undefined;
    if (workflowId) {
      if (rename) {
        rename.activeCount += 1;
        rename.latestRequestId = requestId;
      } else {
        rename = {
          activeCount: 1,
          latestRequestId: requestId,
          confirmedName: previousName,
        };
        queue.renames.set(workflowId, rename);
      }
    }

    set(currentWorkflowNameAtom, name);

    const outcome = await set(saveWorkflowAtom, { name }, { immediate: true });
    if (outcome?.ok === false) {
      if (
        get(currentWorkflowIdAtom) === workflowId &&
        get(currentWorkflowNameAtom) === name &&
        rename?.latestRequestId === requestId
      ) {
        set(currentWorkflowNameAtom, rename.confirmedName);
      }
      if (workflowId) {
        forgetRefusedName(queue, workflowId, name);
      }
      if (workflowId && rename && --rename.activeCount === 0) {
        queue.renames.delete(workflowId);
      }
      return outcome.error;
    }

    if (workflowId && rename && --rename.activeCount === 0) {
      queue.renames.delete(workflowId);
    }

    return null;
  }
);

/** Switch Live/Test. Immediate, because the UI reports the result straight away. */
export const setWorkflowModeAtom = atom(
  null,
  async (_get, set, mode: WorkflowMode): Promise<SaveOutcome | null> =>
    await set(saveWorkflowAtom, { mode }, { immediate: true })
);
