import { atom, type Getter, type Setter } from "jotai";
import { toast } from "sonner";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { DRAFT_CONFLICT_CODE } from "@wfgraph/shared/rpc/error-codes";
import { getClientLogger } from "#src/lib/logger";
import { queryClient } from "#src/lib/query-client";
import { ApiError, type SavedWorkflow, workflowApi } from "#src/lib/rpc-client";
import { cacheWorkflowPublication, orpcQuery } from "#src/lib/rpc-query";
import { groupStructureRefusalReason } from "@wfgraph/shared/graph/group-structure";
import {
  toPersistedEdge,
  toPersistedNodes,
  type WorkflowEdge,
  type WorkflowMode,
  type WorkflowNode,
  type WorkflowVisibility,
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
const workflowDraftRevisionsAtom = atom(new Map<string, number>());
export const currentWorkflowDraftRevisionAtom = atom((get) => {
  const workflowId = get(currentWorkflowIdAtom);
  return workflowId
    ? (get(workflowDraftRevisionsAtom).get(workflowId) ?? 0)
    : 0;
});
export const workflowNotFoundAtom = atom(false);
/** Mark a missing workflow only while the editor still owns that workflow. */
export const markWorkflowNotFoundAtom = atom(
  null,
  (get, set, workflowId: string) => {
    if (get(currentWorkflowIdAtom) === workflowId) {
      set(workflowNotFoundAtom, true);
    }
  }
);
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
 * The last save failure, or null after a save succeeds. The status strip reads
 * it; the toast that reports a failure comes from the queue itself, once.
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
 * How long the queue waits before it resends a graph a request failed to
 * store: `initialMs` after the first failure, doubling with each automatic
 * resend that fails too, never longer than `maxMs`. Any successful save starts
 * the doubling over.
 */
export const saveRetryBackoffAtom = atom({ initialMs: 2000, maxMs: 30_000 });

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

/** The graph half of a patch, which travels whole. */
type WorkflowGraphPatch = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

/**
 * Merge an earlier patch with a later one, field by field, the later patch
 * winning. `nodes` and `edges` belong together, so the graph is taken whole
 * from the later patch that has one instead of merged key by key.
 */
function mergePatches(
  earlier: WorkflowPatch,
  later: WorkflowPatch
): WorkflowPatch {
  // A field neither patch sets stays absent rather than present holding
  // undefined, so a rename the server refused does not reappear as a `name` key
  // on every later save.
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
 * behind it, and a rejection nothing handles is an unhandled rejection. The
 * queue reports a failure to the operator itself, because a debounced save has
 * no caller to do it, so a caller reads the outcome only to decide what to do
 * next.
 */
export type SaveOutcome =
  | { ok: true; workflow: SavedWorkflow }
  | { ok: false; error: Error };

type PendingSave = {
  workflowId: string;
  patch: WorkflowPatch;
  expectedDraftRevision: number;
  /** Resolved once the `update` carrying this patch comes back. */
  waiters: Array<(outcome: SaveOutcome) => void>;
  /**
   * True while only the queue asked for this request, as a resend of a held
   * graph. Its failure is reported by the status strip alone, so a server that
   * stays down for a minute does not raise a toast per attempt.
   */
  automatic: boolean;
};

/**
 * A graph a failed request did not store, held per workflow until a later
 * request carries it. Opening the workflow again restores it on the canvas.
 */
type HeldGraph = {
  graph: WorkflowGraphPatch;
  /**
   * The draft revision the failed request expected. A resend expects it again,
   * so a draft another client saved in the meantime is refused as a conflict
   * and never overwritten.
   */
  expectedDraftRevision: number;
  /** Why the request failed, shown again when the workflow is reopened. */
  error: Error;
  /** Whether the queue resends the graph by itself, after a backoff or when asked. */
  resend: boolean;
};

/** The failure a held graph carries, as hydration reads it. */
export type HeldGraphFailure = Pick<
  HeldGraph,
  "expectedDraftRevision" | "error"
>;

type SaveQueue = {
  timeoutId: ReturnType<typeof setTimeout> | null;
  /**
   * Oldest first. A queue rather than a single slot because navigating away
   * from a workflow with an edit still pending must send that edit, not drop
   * it — and dropping it would also strand everyone awaiting it.
   */
  pending: PendingSave[];
  /** The entry whose `update` is on the wire, already taken off `pending`. */
  inFlight: PendingSave | null;
  /**
   * The graph a failed request did not persist, kept per workflow until
   * another save for that workflow carries it, and through any number of
   * workflow switches. Without this, a later partial save (for example a
   * rename after a graph write) can succeed and make the editor look clean
   * while the failed graph is still absent on the server, and reopening the
   * workflow would show the server's older graph as saved.
   * A failed name or mode is not kept: the caller that asked for it reports the
   * failure and shows the old value again, so sending it later would write a
   * value the editor no longer displays.
   */
  failedGraphs: Map<string, HeldGraph>;
  /** The timer that resends the held graphs marked `resend`, or null. */
  retryTimeoutId: ReturnType<typeof setTimeout> | null;
  /** Automatic resends that failed since the last successful save. */
  retryFailureCount: number;
  /**
   * The newest graph `saveWorkflowAtom` refused before queueing it, per
   * workflow, held until an accepted graph for that workflow is queued or the
   * workflow is loaded again. While one is held, a successful save of an older
   * patch keeps the dirty flag raised and reports this refusal.
   */
  refusedGraphs: Map<string, Error>;
  /** Draft conflicts block retries until a fresh workflow load resets the revision. */
  blockedConflicts: Map<string, Error>;
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
  inFlight: null,
  failedGraphs: new Map(),
  retryTimeoutId: null,
  retryFailureCount: 0,
  refusedGraphs: new Map(),
  blockedConflicts: new Map(),
  renames: new Map(),
  nextRenameRequestId: 0,
  isFlushing: false,
}));

/** The workflows holding a failed graph, mirrored from the queue so React can read it. */
const heldGraphWorkflowIdsAtom = atom<ReadonlySet<string>>(new Set<string>());

/**
 * Whether any workflow, the open one or one the editor has left, holds a graph
 * the server has not stored. Leaving the page while one does loses it.
 */
export const hasHeldGraphSaveAtom = atom(
  (get) => get(heldGraphWorkflowIdsAtom).size > 0
);

function syncHeldGraphs(set: Setter, queue: SaveQueue) {
  set(heldGraphWorkflowIdsAtom, new Set(queue.failedGraphs.keys()));
}

/** Take a workflow's held graph out of the queue, for a request that carries it. */
function releaseHeldGraph(
  set: Setter,
  queue: SaveQueue,
  workflowId: string
): HeldGraph | undefined {
  const held = queue.failedGraphs.get(workflowId);
  if (held) {
    queue.failedGraphs.delete(workflowId);
    syncHeldGraphs(set, queue);
  }
  return held;
}

/**
 * Whether a failed request could succeed unchanged later: no answer arrived,
 * which the client reports as a 500, or the server said it could not take the
 * request right now.
 */
function isTransientSaveFailure(error: unknown): boolean {
  return (
    !(error instanceof ApiError) ||
    error.status >= 500 ||
    error.status === 408 ||
    error.status === 429
  );
}

/**
 * The newest graph of a workflow the server has not stored, or null: queued or
 * in flight, or held after a failed request. A snapshot read while one is
 * outstanding is older than what the editor last showed for that workflow.
 * `failure` is set when the graph is a held one.
 */
export function outstandingGraph(
  get: Getter,
  workflowId: string
): (WorkflowGraphPatch & { failure: HeldGraphFailure | null }) | null {
  const queue = get(saveQueueAtom);
  const newest = [queue.inFlight, ...queue.pending].findLast(
    (entry) => entry?.workflowId === workflowId && entry.patch.nodes
  );
  if (newest?.patch.nodes) {
    return {
      nodes: newest.patch.nodes,
      edges: newest.patch.edges,
      failure: null,
    };
  }
  const held = queue.failedGraphs.get(workflowId);
  return held
    ? {
        ...held.graph,
        failure: {
          expectedDraftRevision: held.expectedDraftRevision,
          error: held.error,
        },
      }
    : null;
}

/** Installs a server revision and clears any stale-write block for that workflow. */
export const recordLoadedDraftRevisionAtom = atom(
  null,
  (get, set, input: { workflowId: string; draftRevision: number }) => {
    set(
      workflowDraftRevisionsAtom,
      new Map(get(workflowDraftRevisionsAtom)).set(
        input.workflowId,
        input.draftRevision
      )
    );
    const queue = get(saveQueueAtom);
    queue.blockedConflicts.delete(input.workflowId);
    releaseHeldGraph(set, queue, input.workflowId);
    queue.refusedGraphs.delete(input.workflowId);
  }
);

/**
 * Send a workflow's held graph again now, as the workflow is opened with it
 * restored on the canvas. The workflow's revision goes back to the one the
 * held graph was written against, which is what the editor's graph is based
 * on, and a conflict that blocked it is lifted so the server answers again.
 */
export const resendHeldGraphAtom = atom(
  null,
  (get, set, workflowId: string) => {
    const queue = get(saveQueueAtom);
    const held = queue.failedGraphs.get(workflowId);
    if (!held) {
      return;
    }
    set(
      workflowDraftRevisionsAtom,
      new Map(get(workflowDraftRevisionsAtom)).set(
        workflowId,
        held.expectedDraftRevision
      )
    );
    queue.blockedConflicts.delete(workflowId);
    queue.refusedGraphs.delete(workflowId);
    resendHeldGraphs(get, set, queue, workflowId);
  }
);

/** Send every held graph marked `resend` now, as the browser coming back online asks. */
export const retryHeldGraphSavesAtom = atom(null, (get, set) => {
  resendHeldGraphs(get, set, get(saveQueueAtom));
});

/**
 * Queue held graphs for another request: each one marked `resend`, and the one
 * held for `onlyWorkflowId` whatever its mark. A held graph goes ahead of any
 * newer patch queued for its workflow, which wins field by field.
 */
function resendHeldGraphs(
  get: Getter,
  set: Setter,
  queue: SaveQueue,
  onlyWorkflowId?: string
) {
  if (queue.retryTimeoutId) {
    clearTimeout(queue.retryTimeoutId);
    queue.retryTimeoutId = null;
  }
  const resent = [...queue.failedGraphs].filter(([workflowId, held]) =>
    onlyWorkflowId === undefined ? held.resend : workflowId === onlyWorkflowId
  );
  for (const [workflowId, held] of resent) {
    queue.failedGraphs.delete(workflowId);
    const later = queue.pending.find(
      (pending) => pending.workflowId === workflowId
    );
    if (later) {
      later.patch = mergePatches(held.graph, later.patch);
    } else {
      queue.pending.push({
        workflowId,
        patch: held.graph,
        expectedDraftRevision: held.expectedDraftRevision,
        waiters: [],
        automatic: true,
      });
    }
  }
  syncHeldGraphs(set, queue);
  // A held graph not resent here keeps its timer.
  scheduleHeldGraphResend(get, set, queue);
  if (resent.length > 0) {
    flushSaveQueue(get, set, queue).catch((error: unknown) => {
      logger.error("Save flush failed", { error });
    });
  }
}

/** Start the backoff timer when a held graph is marked `resend` and none is running. */
function scheduleHeldGraphResend(get: Getter, set: Setter, queue: SaveQueue) {
  if (
    queue.retryTimeoutId !== null ||
    ![...queue.failedGraphs.values()].some((held) => held.resend)
  ) {
    return;
  }
  const backoff = get(saveRetryBackoffAtom);
  const delay = Math.min(
    backoff.initialMs * 2 ** queue.retryFailureCount,
    backoff.maxMs
  );
  queue.retryTimeoutId = setTimeout(() => {
    queue.retryTimeoutId = null;
    resendHeldGraphs(get, set, queue);
  }, delay);
}

function reportSaveFailure(error: Error) {
  toast.error(error.message || "Failed to save workflow");
}

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
 * Why the server's draft save would refuse this graph's Group structure, or
 * null when it would store it. A Group that breaks the Publish rules, such as
 * one holding fewer than two steps, still saves.
 */
function groupPatchRefusalReason(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): string | null {
  return groupStructureRefusalReason({
    nodes: toPersistedNodes(nodes),
    edges: edges.map(toPersistedEdge),
  });
}

/**
 * Send the queued patches one at a time, oldest first, until none is left.
 * Single-flight: a call while a drain is running returns at once, and the
 * running drain picks up what was queued meanwhile.
 */
async function flushSaveQueue(
  get: Getter,
  set: Setter,
  queue: SaveQueue
): Promise<void> {
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
      queue.inFlight = next;

      let outcome: SaveOutcome;
      try {
        const blockedConflict = queue.blockedConflicts.get(next.workflowId);
        if (blockedConflict) {
          throw blockedConflict;
        }
        // eslint-disable-next-line no-await-in-loop -- saves must remain sequential to preserve latest-write semantics.
        const workflow = await get(workflowApiAtom).update(
          next.workflowId,
          toUpdatePayload(next.patch),
          next.expectedDraftRevision
        );
        outcome = { ok: true, workflow };
        queue.retryFailureCount = 0;
        if (next.patch.nodes) {
          const draftRevisions = get(workflowDraftRevisionsAtom);
          set(
            workflowDraftRevisionsAtom,
            new Map(draftRevisions).set(next.workflowId, workflow.draftRevision)
          );
          for (const pending of queue.pending) {
            if (pending.workflowId === next.workflowId) {
              pending.expectedDraftRevision = workflow.draftRevision;
            }
          }
        }
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
        markWorkflowListStale();
        cacheWorkflowPublication(queryClient, workflow);

        // The queue drains workflows the editor may already have left, so
        // the clock reading and the failure are only true of the workflow
        // on screen. Written under the same guard as the dirty flag below:
        // without it, saving A at 12:04 and then opening B had B's strip
        // claiming a write that never happened to it.
        if (get(currentWorkflowIdAtom) === next.workflowId) {
          set(lastSavedAtAtom, new Date());
          set(
            lastSaveErrorAtom,
            queue.refusedGraphs.get(next.workflowId) ?? null
          );
        }

        // Clear the dirty flag only when nothing newer is queued and the
        // saved workflow is still the one on screen.
        if (
          !queue.pending.some(
            (pending) => pending.workflowId === next.workflowId
          ) &&
          !queue.failedGraphs.has(next.workflowId) &&
          !queue.refusedGraphs.has(next.workflowId) &&
          get(currentWorkflowIdAtom) === next.workflowId
        ) {
          set(hasUnsavedChangesAtom, false);
        }
      } catch (error) {
        const saveError = toError(error);
        const blocked = queue.blockedConflicts.get(next.workflowId) === error;
        // A refusal by a conflict already reported sends no request, so it
        // is not a new failure to tell the operator about. Nor is the failure
        // of a resend only the queue asked for: the status strip says it.
        if (!(blocked || next.automatic)) {
          reportSaveFailure(saveError);
        }
        const conflict =
          error instanceof ApiError && error.code === DRAFT_CONFLICT_CODE;
        if (conflict) {
          queue.blockedConflicts.set(next.workflowId, saveError);
        }
        if (next.automatic) {
          queue.retryFailureCount += 1;
        }
        outcome = { ok: false, error: saveError };
        if (get(currentWorkflowIdAtom) === next.workflowId) {
          set(lastSaveErrorAtom, saveError);
        }

        // A later partial patch must not make this failed graph
        // disappear. Fold it into the next queued write for the same
        // workflow when there is one; otherwise hold it until that
        // workflow is edited or opened again, or the queue resends it. A
        // later graph replaces it whole.
        if (next.patch.nodes) {
          const failedGraph = {
            nodes: next.patch.nodes,
            edges: next.patch.edges,
          };
          const later = queue.pending.find(
            (pending) => pending.workflowId === next.workflowId
          );
          if (later) {
            later.patch = mergePatches(failedGraph, later.patch);
          } else {
            queue.failedGraphs.set(next.workflowId, {
              graph: failedGraph,
              expectedDraftRevision: next.expectedDraftRevision,
              error: saveError,
              // A request that carried a name or mode may have been refused
              // for that alone, and the resend carries the graph alone.
              resend:
                !(blocked || conflict) &&
                (isTransientSaveFailure(error) ||
                  next.patch.name !== undefined ||
                  next.patch.mode !== undefined),
            });
            syncHeldGraphs(set, queue);
            scheduleHeldGraphResend(get, set, queue);
          }
        }
        logger.error("Save failed", {
          workflowId: next.workflowId,
          error,
        });
      }

      queue.inFlight = null;
      for (const resolve of next.waiters) {
        resolve(outcome);
      }
    }
  } finally {
    queue.isFlushing = false;
    set(isSavingAtom, false);
  }
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
    const queue = get(saveQueueAtom);
    // A newer edit retires the last failure: the write that failed is not the
    // one the editor is now holding. Without this the failure never clears --
    // the dirty flag is not lowered on the failure path -- and the status
    // readout could never reach "Save failed", because a failed save always
    // leaves something unsaved to report instead. A draft conflict is the
    // exception, because it refuses this edit too until the workflow reloads.
    set(
      lastSaveErrorAtom,
      workflowId ? (queue.blockedConflicts.get(workflowId) ?? null) : null
    );
    if (!workflowId) {
      return null;
    }

    // Every graph writer keeps its Groups whole, so a refusal here means one of
    // them left a Group half built. Nothing is queued, which keeps that graph
    // off the server. The refusal is held in `refusedGraphs`, so an older patch
    // still queued cannot report the edit as saved when it lands.
    const groupRefusal = patch.nodes
      ? groupPatchRefusalReason(patch.nodes, patch.edges)
      : null;
    if (groupRefusal) {
      const error = new Error(groupRefusal);
      queue.refusedGraphs.set(workflowId, error);
      set(lastSaveErrorAtom, error);
      reportSaveFailure(error);
      logger.error("Save refused a malformed Group", { workflowId });
      return { ok: false, error };
    }
    if (patch.nodes) {
      queue.refusedGraphs.delete(workflowId);
    }

    const outcome = new Promise<SaveOutcome>((resolve) => {
      // Merge only into the newest entry, and only when it targets the same
      // workflow, so a rename typed during a node drag becomes one request
      // carrying both. An entry for a different workflow stays queued behind it.
      const failedGraph = releaseHeldGraph(set, queue, workflowId)?.graph;
      const patchWithRetry = failedGraph
        ? mergePatches(failedGraph, patch)
        : patch;

      const newest = queue.pending.at(-1);
      if (newest?.workflowId === workflowId) {
        newest.patch = mergePatches(newest.patch, patchWithRetry);
        newest.waiters.push(resolve);
        newest.automatic = false;
        return;
      }

      queue.pending.push({
        workflowId,
        patch: patchWithRetry,
        expectedDraftRevision:
          get(workflowDraftRevisionsAtom).get(workflowId) ?? 0,
        waiters: [resolve],
        automatic: false,
      });
    });

    if (queue.timeoutId) {
      clearTimeout(queue.timeoutId);
      queue.timeoutId = null;
    }

    if (options?.immediate) {
      await flushSaveQueue(get, set, queue);
      return await outcome;
    }

    queue.timeoutId = setTimeout(() => {
      queue.timeoutId = null;
      flushSaveQueue(get, set, queue).catch((error: unknown) => {
        logger.error("Save flush failed", { error });
      });
    }, get(autosaveDelayAtom));

    return await outcome;
  }
);

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
