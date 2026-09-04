import { useQueryClient } from "@tanstack/react-query";
import { ORPCError } from "@orpc/client";
import { useAtomValue, useSetAtom } from "jotai";
import { useAbortableSubscription, useAbortableTask } from "#src/hooks/effects";
import { can } from "#src/lib/authorization";
import { getClientLogger } from "#src/lib/logger";
import {
  installRemoteWorkflowAtom,
  observedRemoteDraftRevisionAtom,
  recordObservedRemoteDraftRevisionAtom,
  remoteWorkflowUpdateDispositionAtom,
} from "#src/lib/workflow-graph-store";
import {
  currentWorkflowDraftRevisionAtom,
  markWorkflowNotFoundAtom,
} from "#src/lib/workflow-save-store";
import { orpcQuery } from "#src/lib/rpc-query";
import { ApiError, rpc, toSavedWorkflow } from "#src/lib/rpc-client";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

const logger = getClientLogger("workflow", "draft-sync");
const DRAFT_SNAPSHOT_RETRY_MS = 500;

const PERMANENT_DRAFT_ERROR_CODES = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
]);

function isPermanentDraftError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 401 || error.status === 403 || error.status === 404;
  }
  return (
    error instanceof ORPCError && PERMANENT_DRAFT_ERROR_CODES.has(error.code)
  );
}

function isDraftNotFound(error: unknown): boolean {
  return (
    (error instanceof ApiError && error.status === 404) ||
    (error instanceof ORPCError && error.code === "NOT_FOUND")
  );
}

/** Wait before retrying a graph read while still allowing navigation to cancel it. */
function waitForSnapshotRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(done, DRAFT_SNAPSHOT_RETRY_MS);
    signal.addEventListener("abort", done, { once: true });

    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** Synchronizes persisted edits from external clients into the open draft. */
export function WorkflowDraftSync({ workflowId }: { workflowId: string }) {
  const localRevision = useAtomValue(currentWorkflowDraftRevisionAtom);
  const observedRevision = useAtomValue(observedRemoteDraftRevisionAtom);
  const updateDisposition = useAtomValue(remoteWorkflowUpdateDispositionAtom);
  const installRemoteWorkflow = useSetAtom(installRemoteWorkflowAtom);
  const recordObservedRevision = useSetAtom(
    recordObservedRemoteDraftRevisionAtom
  );
  const markWorkflowNotFound = useSetAtom(markWorkflowNotFoundAtom);
  const queryClient = useQueryClient();
  const canReadWorkflow = can(WfGraphOperations.workflowSubscribeDraft.id);
  useAbortableSubscription({
    key: `${workflowId}:${localRevision}`,
    enabled: canReadWorkflow && localRevision > 0,
    subscribe: (signal) =>
      rpc.workflow.subscribeDraft(
        { workflowId, afterDraftRevision: localRevision },
        {
          signal,
          context: {
            retry: Number.POSITIVE_INFINITY,
            shouldRetry: ({ error }) => !isPermanentDraftError(error),
          },
        }
      ),
    onValue: (event) => {
      if (event.workflowId !== workflowId) {
        return;
      }

      recordObservedRevision(event);
    },
    onError: (error) => {
      if (isDraftNotFound(error)) {
        markWorkflowNotFound(workflowId);
        return;
      }
      logger.warn("Draft subscription stopped", { workflowId });
    },
  });

  const remoteRevision =
    observedRevision?.workflowId === workflowId
      ? observedRevision.draftRevision
      : localRevision;
  const hasNewerDraft = remoteRevision > localRevision;
  const canInstall = hasNewerDraft && updateDisposition === "install";

  useAbortableTask({
    key: `${workflowId}:${canInstall}:${remoteRevision}`,
    enabled: canInstall,
    run: async (signal) => {
      const queryKey = orpcQuery.workflow.getById.queryKey({
        input: { workflowId },
      });
      const cancelSnapshotRead = () => {
        void queryClient.cancelQueries({ queryKey, exact: true });
      };
      signal.addEventListener("abort", cancelSnapshotRead, { once: true });
      let candidate: ReturnType<typeof toSavedWorkflow> | undefined;

      try {
        while (!signal.aborted) {
          const targetRevision = remoteRevision;

          if (!candidate || candidate.draftRevision < targetRevision) {
            try {
              // Snapshot reads are sequential so an older response cannot finish
              // after a newer response and replace the newer graph.
              // eslint-disable-next-line no-await-in-loop
              const workflow = await queryClient.query({
                ...orpcQuery.workflow.getById.queryOptions({
                  input: { workflowId },
                }),
                staleTime: 0,
              });
              candidate = toSavedWorkflow(workflow);
            } catch (error) {
              if (signal.aborted) {
                return;
              }
              if (isDraftNotFound(error)) {
                markWorkflowNotFound(workflowId);
                return;
              }
              if (isPermanentDraftError(error)) {
                throw error;
              }
              // A transient read failure must not lose the revision notification.
              // eslint-disable-next-line no-await-in-loop
              await waitForSnapshotRetry(signal);
              continue;
            }
          }

          if (
            !signal.aborted &&
            candidate.draftRevision >= remoteRevision &&
            installRemoteWorkflow(candidate)
          ) {
            return;
          }

          // A replica can briefly trail the revision event, and a node drag can
          // temporarily reject an otherwise current graph.
          // eslint-disable-next-line no-await-in-loop
          await waitForSnapshotRetry(signal);
        }
      } finally {
        signal.removeEventListener("abort", cancelSnapshotRead);
      }
    },
    onError: () => {
      logger.warn("Draft synchronization stopped", { workflowId });
    },
  });

  return null;
}
