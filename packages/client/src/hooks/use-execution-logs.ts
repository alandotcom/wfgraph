import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { toExecutionLogsByNodeId } from "#src/lib/execution-logs";
import { orpcQuery } from "#src/lib/rpc-query";
import { selectedExecutionIdAtom } from "#src/lib/workflow-ui-store";
import type { ExecutionLogEntry } from "@rova/shared/graph/types";

const NO_LOGS: Record<string, ExecutionLogEntry> = {};

/**
 * The latest log entry per node for the run the user is looking at, keyed by
 * node id.
 *
 * Every ActionNode on the canvas calls this, which is one query with N
 * observers rather than N requests, so a node's badge never depends on the
 * runs panel being mounted to notice a change.
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
    enabled: selectedExecutionId !== null,
  });

  return data ?? NO_LOGS;
}
