import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Play } from "lucide-react";
import { useState } from "react";
import { Button } from "#src/components/ui/button";
import { Spinner } from "#src/components/ui/spinner";
import { useAfterCommit } from "#src/hooks/effects";
import {
  isRunInProgress,
  toExecutionDetail,
  toExecutionEvents,
  toWorkflowExecutions,
  type WorkflowExecution,
} from "#src/lib/execution-logs";
import { orpcQuery, refreshRunHistory } from "#src/lib/rpc-query";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import { toEditorEdge, toEditorNode } from "#src/lib/workflow-graph-types";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { selectedExecutionIdAtom } from "#src/lib/workflow-ui-store";
import { toWorkflowGraphData } from "@rova/shared/graph/graph";
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

/** The open run, and the position it held in the list when it was opened. */
type OpenRun = {
  execution: WorkflowExecution;
  runNumber: number;
};

const LEFT_THE_LIST_NOTICE =
  "This run has left the runs list, so what it shows stops here. A newer start supersedes the runs going for the same entity, and the list holds the newest 50.";

export function WorkflowRuns() {
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const [selectedExecutionId, setSelectedExecutionId] = useAtom(
    selectedExecutionIdAtom
  );
  const queryClient = useQueryClient();

  // Which run the detail view is showing, held as the row itself. Null means the
  // list.
  //
  // The row rather than an id, because the list this panel polls is filtered and
  // capped: a newest-wins workflow supersedes the open run out of it, and a busy
  // one pushes it past the newest 50. A detail view that existed only while its
  // row was in the list closed itself mid-read when either happened.
  const [openRun, setOpenRun] = useState<OpenRun | null>(null);
  // Superseded runs are the ones a newer start displaced. They are hidden by
  // default because a newest-wins workflow makes one on every reschedule, and a
  // builder opens this panel to see what ran, not what was replaced.
  const [showSuperseded, setShowSuperseded] = useState(false);
  const setExecutionOverlay = useSetAtom(executionOverlayGraphAtom);

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

  const activeRunId = openRun?.execution.id ?? null;
  // The open run's row as the list has it now, or undefined once it has left.
  const listedRun = executions.find(
    (execution) => execution.id === activeRunId
  );

  // Both detail queries follow the same run, so they read its status from the
  // same place: the list, which is polling anyway. Deriving it from each
  // query's own payload would give the events poll no way to know it had
  // finished, since the events endpoint does not report a status. A run that
  // has left the list reports no status, which is what stops the polling.
  const detailPollInterval = isRunInProgress(listedRun?.status)
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

  // Paint the version this run pinned onto the canvas so statuses land on the
  // graph it walked, not the live draft. Cleared when the run is closed.
  useAfterCommit(detailQuery.data?.graph ?? activeRunId, () => {
    const graph = detailQuery.data?.graph;
    if (!activeRunId || !graph) {
      setExecutionOverlay(null);
      return;
    }

    const graphData = toWorkflowGraphData(graph);
    setExecutionOverlay({
      nodes: graphData.nodes.map((node) => {
        const editorNode = toEditorNode(node);
        return {
          ...editorNode,
          selected: false,
          data: { ...editorNode.data, status: "idle" as const },
        };
      }),
      edges: graphData.edges.map(toEditorEdge),
    });
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
    const index = executions.findIndex(
      (execution) => execution.id === executionId
    );
    const execution = executions[index];
    if (!execution) {
      return;
    }

    setOpenRun({ execution, runNumber: executions.length - index });
    setSelectedExecutionId(executionId);
  };

  const handleBack = () => {
    setOpenRun(null);
    setSelectedExecutionId(null);
    setExecutionOverlay(null);
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

  // Detail view. Ahead of the empty-list branch, because a run being read keeps
  // its view whether or not the list behind it still holds a row for it.
  if (openRun) {
    const execution = listedRun ?? openRun.execution;
    const runNumber = listedRun
      ? executions.length - executions.indexOf(listedRun)
      : openRun.runNumber;

    return (
      <WorkflowRunDetail
        events={eventsQuery.data ?? []}
        execution={execution}
        isCanceling={
          cancelExecution.isPending &&
          cancelExecution.variables?.executionId === execution.id
        }
        isResuming={resumeWait.isPending}
        logs={detailQuery.data?.logs ?? []}
        notice={listedRun ? undefined : LEFT_THE_LIST_NOTICE}
        onBack={handleBack}
        onCancel={(executionId) => cancelExecution.mutate({ executionId })}
        onResume={(token) => resumeWait.mutate({ token })}
        runNumber={runNumber}
        waits={detailQuery.data?.waits ?? []}
      />
    );
  }

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
