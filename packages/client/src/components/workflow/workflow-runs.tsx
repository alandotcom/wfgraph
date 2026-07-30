import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAtom, useAtomValue } from "jotai";
import { Play } from "lucide-react";
import { useState } from "react";
import { Button } from "#src/components/ui/button";
import { Spinner } from "#src/components/ui/spinner";
import {
  isRunInProgress,
  toExecutionDetail,
  toExecutionEvents,
  toWorkflowExecutions,
} from "#src/lib/execution-logs";
import { orpcQuery, refreshRunHistory } from "#src/lib/rpc-query";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { selectedExecutionIdAtom } from "#src/lib/workflow-ui-store";
import { WorkflowRefusedStarts } from "./workflow-refused-starts";
import { WorkflowRunDetail } from "./workflow-run-detail";
import { WorkflowRunsList } from "./workflow-runs-list";

/** How often a run that is still going gets re-read. */
const RUN_POLL_MS = 2000;

/**
 * The row cap the server reads under, mirrored here for one sentence only: past
 * this many superseded runs, showing them cannot show them all, and a label that
 * promised otherwise would be a lie a builder could count.
 */
const EXECUTIONS_PAGE_CAP = 50;

export function WorkflowRuns() {
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const [selectedExecutionId, setSelectedExecutionId] = useAtom(
    selectedExecutionIdAtom
  );
  const queryClient = useQueryClient();

  // Which run the detail view is showing. Null means the list.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // Superseded runs are the ones a newer start displaced. They are hidden by
  // default because a newest-wins workflow makes one on every reschedule, and a
  // builder opens this panel to see what ran, not what was replaced.
  const [showSuperseded, setShowSuperseded] = useState(false);

  const executionsQuery = useQuery({
    ...orpcQuery.workflow.getExecutions.queryOptions({
      input: {
        workflowId: currentWorkflowId ?? "",
        includeSuperseded: showSuperseded,
      },
      select: toWorkflowExecutions,
    }),
    enabled: currentWorkflowId !== null,
    staleTime: 0,
    refetchInterval: RUN_POLL_MS,
    // Toggling the superseded rows changes the query key, and without this the
    // panel would unmount its own list and flash the empty state on the click
    // that asked to see more of it.
    placeholderData: keepPreviousData,
  });

  const executions = executionsQuery.data?.executions ?? [];
  const supersededCount = executionsQuery.data?.supersededCount ?? 0;
  const refusedStarts = executionsQuery.data?.refusedStarts ?? [];

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
  const detailQuery = useQuery({
    ...orpcQuery.workflow.getExecutionLogs.queryOptions({
      input: { executionId: activeRunId ?? "" },
      select: toExecutionDetail,
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
      onSuccess: () => refreshRunHistory(queryClient),
      meta: { errorMessage: "Failed to cancel run" },
    })
  );

  const resumeWait = useMutation(
    orpcQuery.workflow.resumeWait.mutationOptions({
      onSuccess: () => refreshRunHistory(queryClient),
      meta: { errorMessage: "Failed to resume the run" },
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

  const supersededToggle =
    supersededCount > 0 ? (
      <div className="flex items-center justify-between gap-2 border-b px-1 pb-2">
        <p className="text-muted-foreground text-xs">
          {supersededCount === 1
            ? "1 run was superseded by a newer start"
            : `${supersededCount} runs were superseded by newer starts`}
          {supersededCount > EXECUTIONS_PAGE_CAP
            ? `, of which the newest ${EXECUTIONS_PAGE_CAP} can be shown`
            : ""}
        </p>
        <Button
          onClick={() => setShowSuperseded((shown) => !shown)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {showSuperseded ? "Hide" : "Show"}
        </Button>
      </div>
    ) : null;

  if (executions.length === 0) {
    return (
      <div className="space-y-2">
        {supersededToggle}
        <WorkflowRefusedStarts refusedStarts={refusedStarts} />
        <div className="flex flex-col items-center justify-center py-16">
          <div className="mb-3 rounded-lg border border-dashed p-4">
            <Play className="size-6 text-muted-foreground" />
          </div>
          <div className="font-medium text-foreground text-sm">No runs yet</div>
          <div className="mt-1 text-muted-foreground text-xs">
            Execute your workflow to see runs here
          </div>
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
        isResuming={resumeWait.isPending}
        logs={detailQuery.data?.logs ?? []}
        onBack={handleBack}
        onCancel={(executionId) => cancelExecution.mutate({ executionId })}
        onResume={(token) => resumeWait.mutate({ token })}
        runNumber={runNumber}
        waits={detailQuery.data?.waits ?? []}
      />
    );
  }

  // List view
  return (
    <div className="space-y-2">
      {supersededToggle}
      <WorkflowRefusedStarts refusedStarts={refusedStarts} />
      <WorkflowRunsList
        executions={executions}
        onSelect={handleSelectRun}
        selectedId={selectedExecutionId}
      />
    </div>
  );
}
