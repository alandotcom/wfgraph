import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom, useAtomValue } from "jotai";
import { Play } from "lucide-react";
import { useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import {
  isRunInProgress,
  toExecutionEvents,
  toExecutionLogs,
  toWorkflowExecutions,
} from "@/lib/execution-logs";
import { orpcQuery } from "@/lib/rpc-query";
import { currentWorkflowIdAtom } from "@/lib/workflow-save-store";
import { selectedExecutionIdAtom } from "@/lib/workflow-ui-store";
import { WorkflowRunDetail } from "./workflow-run-detail";
import { WorkflowRunsList } from "./workflow-runs-list";

/** How often a run that is still going gets re-read. */
const RUN_POLL_MS = 2000;

export function WorkflowRuns() {
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const [selectedExecutionId, setSelectedExecutionId] = useAtom(
    selectedExecutionIdAtom
  );
  const queryClient = useQueryClient();

  // Which run the detail view is showing. Null means the list.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const executionsQuery = useQuery({
    ...orpcQuery.workflow.getExecutions.queryOptions({
      input: { workflowId: currentWorkflowId ?? "" },
      select: toWorkflowExecutions,
    }),
    enabled: currentWorkflowId !== null,
    staleTime: 0,
    refetchInterval: RUN_POLL_MS,
  });

  const executions = executionsQuery.data ?? [];

  // Both detail queries follow the same run, so they read its status from the
  // same place: the list, which is polling anyway. Deriving it from each
  // query's own payload would give the events poll no way to know it had
  // finished, since the events endpoint does not report a status.
  const activeRunStatus = executions.find(
    (execution) => execution.id === activeRunId
  )?.status;
  const detailPollInterval = isRunInProgress(activeRunStatus)
    ? RUN_POLL_MS
    : false;

  // Opening a run enables its logs and events; the cache decides whether that
  // means a request. Both stop once the run is finished, which the single
  // interval this replaced could not do: it refreshed the open run forever,
  // long after there was anything left to learn about it.
  const logsQuery = useQuery({
    ...orpcQuery.workflow.getExecutionLogs.queryOptions({
      input: { executionId: activeRunId ?? "" },
      select: toExecutionLogs,
    }),
    enabled: activeRunId !== null,
    staleTime: 0,
    refetchInterval: detailPollInterval,
  });

  const eventsQuery = useQuery({
    ...orpcQuery.workflow.getExecutionEvents.queryOptions({
      input: { executionId: activeRunId ?? "" },
      select: toExecutionEvents,
    }),
    enabled: activeRunId !== null,
    staleTime: 0,
    refetchInterval: detailPollInterval,
  });

  const cancelExecution = useMutation(
    orpcQuery.workflow.cancelExecution.mutationOptions({
      // Only the run list, never the whole workflow area: a broad invalidation
      // from inside the editor would mark the workflow itself stale, and an
      // observer on it would refetch, rehydrate the graph, re-run the
      // integration repair and save again over whatever the user was typing.
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: orpcQuery.workflow.getExecutions.key(),
        }),
      meta: { errorMessage: "Failed to cancel run" },
    })
  );

  const handleSelectRun = (executionId: string) => {
    setActiveRunId(executionId);
    setSelectedExecutionId(executionId);
  };

  const handleBack = () => {
    setActiveRunId(null);
    setSelectedExecutionId(null);
  };

  if (executionsQuery.isPending) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (executions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <div className="mb-3 rounded-lg border border-dashed p-4">
          <Play className="size-6 text-muted-foreground" />
        </div>
        <div className="font-medium text-foreground text-sm">No runs yet</div>
        <div className="mt-1 text-muted-foreground text-xs">
          Execute your workflow to see runs here
        </div>
      </div>
    );
  }

  // Detail view
  const activeExecution = activeRunId
    ? executions.find((e) => e.id === activeRunId)
    : null;

  if (activeExecution) {
    const runIndex = executions.indexOf(activeExecution);
    const runNumber = executions.length - runIndex;

    return (
      <WorkflowRunDetail
        events={eventsQuery.data ?? []}
        execution={activeExecution}
        isCanceling={
          cancelExecution.isPending &&
          cancelExecution.variables?.executionId === activeExecution.id
        }
        logs={logsQuery.data ?? []}
        onBack={handleBack}
        onCancel={(executionId) => cancelExecution.mutate({ executionId })}
        runNumber={runNumber}
      />
    );
  }

  // List view
  return (
    <WorkflowRunsList
      executions={executions}
      onSelect={handleSelectRun}
      selectedId={selectedExecutionId}
    />
  );
}
