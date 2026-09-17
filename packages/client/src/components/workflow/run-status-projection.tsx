import { useQuery } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { useAfterCommit } from "#src/hooks/effects";
import { can } from "#src/lib/authorization";
import { isRunInProgress, toExecutionStatus } from "#src/lib/execution-logs";
import { runNodeEvidenceStatuses } from "#src/lib/run-node-evidence";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  isExecutionOverlayActiveAtom,
  projectRunProgressAtom,
} from "#src/lib/workflow-graph-store";
import {
  isExecutingAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";

/** How often a run that is still going has its progress read back. */
const RUN_STATUS_POLL_MS = 500;

/**
 * The open run's progress, projected onto the graph as one evidence status per
 * node. Step cards paint from the projection and a Group's run summary counts
 * from it. One status read names each node's status and the nodes holding an
 * open wait, so each read projects a whole snapshot of the run. The projection
 * is the one writer of run statuses when the route opens, switches or closes a
 * run: a run whose status has not been read yet projects no statuses.
 *
 * Private to `RunStatusProjection`, the headless component the editor mounts.
 */
function useRunStatusProjection(): void {
  const selectedExecutionId = useAtomValue(selectedExecutionIdAtom);
  const isExecutionOverlayActive = useAtomValue(isExecutionOverlayActiveAtom);
  const setIsExecuting = useSetAtom(isExecutingAtom);
  const projectRunProgress = useSetAtom(projectRunProgressAtom);

  // While a run is on screen its progress is read back every half second. The
  // predicate is what stops it: once the run reaches a terminal status there is
  // nothing further to learn.
  const executionStatusQuery = useQuery({
    ...orpcQuery.workflow.getExecutionStatus.queryOptions({
      input: { executionId: selectedExecutionId ?? "" },
    }),
    enabled:
      selectedExecutionId !== null &&
      can(WfGraphOperations.workflowGetExecutionStatus.id),
    staleTime: 0,
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      isRunInProgress(query.state.data?.status) ? RUN_STATUS_POLL_MS : false,
  });
  const executionStatus =
    selectedExecutionId === null ? undefined : executionStatusQuery.data;

  const statuses =
    executionStatus === undefined
      ? []
      : runNodeEvidenceStatuses({
          executionStatus: executionStatus.status,
          nodeStatuses: executionStatus.nodeStatuses,
          parkedNodeIds: executionStatus.openWaitNodeIds,
        });

  // The statuses live on the nodes because that is where React Flow reads them
  // from, so this is a write into a store that follows a server response. The
  // key names the run, so opening another run replaces the previous run's
  // snapshot whichever order the editor's headless components commit in.
  // Overlay presence is in the key so a pinned graph that arrives after the
  // statuses gets them projected onto its nodes, since a completed run does
  // not poll again.
  const statusKey = statuses
    .map((item) => `${item.nodeId}=${item.status}`)
    .join(",");
  useAfterCommit(
    `${selectedExecutionId ?? ""}:${isExecutionOverlayActive}:${
      executionStatus === undefined
        ? "none"
        : `${executionStatus.status}:${statusKey}`
    }`,
    () => {
      if (selectedExecutionId === null || executionStatus === undefined) {
        projectRunProgress(null);
        setIsExecuting(false);
        return;
      }

      projectRunProgress({
        executionStatus: toExecutionStatus(executionStatus.status),
        statuses,
      });
      setIsExecuting(isRunInProgress(executionStatus.status));
    }
  );
}

/**
 * Headless owner of the open run's status projection. Mount it once on the
 * workflow editor.
 */
export function RunStatusProjection() {
  useRunStatusProjection();
  return null;
}
