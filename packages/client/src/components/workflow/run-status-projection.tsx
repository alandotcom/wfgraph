import { useQuery } from "@tanstack/react-query";
import { useAtomValue, useAtomValueRawSync, useSetAtom } from "jotai";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { useAfterCommit } from "#src/hooks/effects";
import { can } from "#src/lib/authorization";
import {
  isRunInProgress,
  logsBehindStatusRead,
  toRunPathSource,
} from "#src/lib/execution-logs";
import { runNodeEvidenceStatuses } from "#src/lib/run-node-evidence";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  isExecutionOverlayActiveAtom,
  projectRunLogsAtom,
  projectRunProgressAtom,
} from "#src/lib/workflow-graph-store";
import {
  runStartInFlightAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";
import { RUN_POLL_MS } from "./use-workflow-runs";

/** How often a run that is still going has its progress read back. */
const RUN_STATUS_POLL_MS = 500;

/**
 * The open run's progress, projected onto the graph as one evidence status per
 * node. Step cards paint from the projection and a Group's run summary counts
 * from it. One status read names each node's status, the nodes holding an open
 * wait and the nodes with a step that will run again, so each read projects a
 * whole snapshot of the run. The projection is the one writer of run statuses
 * when the route opens, switches or closes a run: a run whose status has not
 * been read yet projects no statuses, unless a run start is in flight, whose
 * own paint stands until the started run is read.
 *
 * Private to `RunStatusProjection`, the headless component the editor mounts.
 */
function useRunStatusProjection(): RunStatusRead | undefined {
  // Route and overlay synchronizers can write these before subscriptions mount.
  const selectedExecutionId = useAtomValueRawSync(selectedExecutionIdAtom);
  const isExecutionOverlayActive = useAtomValueRawSync(
    isExecutionOverlayActiveAtom
  );
  const runStartInFlight = useAtomValue(runStartInFlightAtom);
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
          retryingNodeIds: executionStatus.retryingNodeIds,
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
        // A start in flight painted the run it asked for, and the started
        // run's first status read is what replaces that paint.
        if (!runStartInFlight) {
          projectRunProgress(null);
        }
        return;
      }

      projectRunProgress({
        executionStatus: executionStatus.status,
        statuses,
      });
    }
  );
  return executionStatus;
}

/** What one status read of the open run answers. */
type RunStatusRead = {
  status: string;
  nodeStatuses: readonly { nodeId: string; status: string }[];
};

/**
 * The open run's logs, written where the canvas reads the path the run took.
 * The read is the Runs view's own query key, so the cache answers both from
 * one entry. The canvas shows the path when no Runs
 * view polls the logs, so they are read again whenever `statusRead`, the
 * status poll's latest answer, shows a step moved since they were read. A run
 * whose steps stand still costs no logs read.
 *
 * Private to `RunStatusProjection`.
 */
function useRunPathProjection(statusRead: RunStatusRead | undefined): void {
  const selectedExecutionId = useAtomValueRawSync(selectedExecutionIdAtom);
  const projectRunLogs = useSetAtom(projectRunLogsAtom);
  const logsQuery = useQuery({
    ...orpcQuery.workflow.getExecutionLogs.queryOptions({
      input: { executionId: selectedExecutionId ?? "" },
      select: toRunPathSource,
    }),
    enabled:
      selectedExecutionId !== null &&
      can(WfGraphOperations.workflowGetExecutionLogs.id),
    staleTime: 0,
    // Compared against this render's status read, so the interval runs only
    // while the logs are behind and stops on the read that catches up.
    refetchInterval: (query) => {
      const data = query.state.data;
      return data !== undefined &&
        statusRead !== undefined &&
        logsBehindStatusRead(toRunPathSource(data), statusRead)
        ? RUN_POLL_MS
        : false;
    },
  });
  const source = selectedExecutionId === null ? undefined : logsQuery.data;

  // The run path is drawn from the store, so this writes a server response
  // into it. The key names the run and the moment of the read, so opening
  // another run replaces the previous run's logs.
  useAfterCommit(
    `${selectedExecutionId ?? ""}:${source === undefined ? "none" : logsQuery.dataUpdatedAt}`,
    () => {
      projectRunLogs(source ?? null);
    }
  );
}

/**
 * Headless owner of the open run's status projection and of the logs its
 * path on the canvas is drawn from. Mount it once on the workflow editor.
 */
export function RunStatusProjection() {
  const statusRead = useRunStatusProjection();
  useRunPathProjection(statusRead);
  return null;
}
