import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import type { ExecutionLogsResult } from "#src/lib/rpc-client";
import {
  type ExecutionWait,
  toExecutionDetail,
  toExecutionLogsByNodeId,
  toTestSkippedNodeIds,
} from "#src/lib/execution-logs";
import { orpcQuery } from "#src/lib/rpc-query";
import { can } from "#src/lib/authorization";
import { selectedExecutionIdAtom } from "#src/lib/workflow-ui-store";
import type { ExecutionLogEntry } from "@wfgraph/shared/graph/types";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

const NO_LOGS: Record<string, ExecutionLogEntry> = {};

/**
 * The latest log entry per node for the run the user is looking at, keyed by
 * node id.
 *
 * Every ActionNode on the canvas calls this, which is one query with N
 * observers rather than N requests, so a node's badge never depends on the
 * Runs view being mounted to notice a change.
 *
 * `toExecutionLogsByNodeId` is module-level on purpose: TanStack memoises a
 * select by identity, so a poll that returns the same JSON hands back the same
 * object and the canvas does not re-render.
 */
export function useExecutionLogsByNode(): Record<string, ExecutionLogEntry> {
  const selectedExecutionId = useAtomValue(selectedExecutionIdAtom);
  const { data } = useQuery({
    ...orpcQuery.workflow.getExecutionLogs.queryOptions({
      input: { executionId: selectedExecutionId ?? "" },
      select: toExecutionLogsByNodeId,
    }),
    enabled:
      selectedExecutionId !== null &&
      can(WfGraphOperations.workflowGetExecutionLogs.id),
  });

  return data ?? NO_LOGS;
}

const NO_NODE_IDS: ReadonlySet<string> = new Set();

/**
 * The nodes of the run the user is looking at whose latest execution did
 * nothing because the run has Test recipients. It observes the same query as
 * `useExecutionLogsByNode`, so it adds no request.
 */
export function useTestSkippedNodeIds(): ReadonlySet<string> {
  const selectedExecutionId = useAtomValue(selectedExecutionIdAtom);
  const { data } = useQuery({
    ...orpcQuery.workflow.getExecutionLogs.queryOptions({
      input: { executionId: selectedExecutionId ?? "" },
      select: toTestSkippedNodeIds,
    }),
    enabled:
      selectedExecutionId !== null &&
      can(WfGraphOperations.workflowGetExecutionLogs.id),
  });

  return data ?? NO_NODE_IDS;
}

const NO_WAITS: readonly ExecutionWait[] = [];

/** The Waits a logs payload's run is parked on, as one stable selector. */
function toExecutionWaits(payload: ExecutionLogsResult): ExecutionWait[] {
  return toExecutionDetail(payload).waits;
}

/**
 * The Waits the run the user is looking at is parked on. It observes the same
 * query as `useExecutionLogsByNode`, so it adds no request.
 */
export function useOpenRunWaits(): readonly ExecutionWait[] {
  const selectedExecutionId = useAtomValue(selectedExecutionIdAtom);
  const { data } = useQuery({
    ...orpcQuery.workflow.getExecutionLogs.queryOptions({
      input: { executionId: selectedExecutionId ?? "" },
      select: toExecutionWaits,
    }),
    enabled:
      selectedExecutionId !== null &&
      can(WfGraphOperations.workflowGetExecutionLogs.id),
  });

  return data ?? NO_WAITS;
}
