import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useState } from "react";
import { Button } from "#src/components/ui/button";
import { cn } from "@wfgraph/shared/utils";
import {
  isRunInProgress,
  toExecutionDetail,
  toExecutionEvents,
  toWorkflowExecutions,
} from "#src/lib/execution-logs";
import { useExitRun } from "#src/hooks/use-exit-run";
import { useAfterCommit } from "#src/hooks/effects";
import { orpcQuery, refreshRunHistory } from "#src/lib/rpc-query";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
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

const LEFT_THE_LIST_NOTICE =
  "This run has left the runs list, so what it shows stops here. A newer start supersedes the runs going for the same entity, and the list holds the newest 50.";

const workflowRouteApi = getRouteApi("/workflows/$workflowId");

function RunsSkeleton({ detail = false }: { detail?: boolean }) {
  return (
    <div
      aria-label="Loading runs"
      aria-busy="true"
      className="flex h-full min-h-0 flex-col"
    >
      <div className="shrink-0 space-y-2 border-b px-3 py-3">
        <div className="h-4 w-2/3 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
        <div className="h-3 w-1/2 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
        {detail ? (
          <div className="mt-3 h-16 animate-pulse rounded-sm bg-muted/70 motion-reduce:animate-none" />
        ) : null}
      </div>
      <div className="min-h-0 flex-1 px-3 py-2">
        {Array.from({ length: detail ? 4 : 6 }, (_, index) => (
          <div className="flex h-13 items-center gap-3 border-b" key={index}>
            <div className="size-2 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-2/3 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
              <div className="h-2.5 w-1/2 animate-pulse rounded-sm bg-muted/70 motion-reduce:animate-none" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RunsListHeader() {
  return (
    <header className="shrink-0 border-b bg-background px-3 py-3">
      <h2 className="font-semibold text-sm">Execution Inspector</h2>
      <p className="mt-0.5 text-muted-foreground text-xs">
        Select a run to inspect its journey on the canvas.
      </p>
    </header>
  );
}

export function WorkflowRuns() {
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const selectedExecutionId = useAtomValue(selectedExecutionIdAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const queryClient = useQueryClient();
  // Which run is open is URL state. ExecutionOverlaySync on the editor shell
  // derives the selection atom and pinned graph; this panel only reads search.
  const { executionId } = workflowRouteApi.useSearch();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const exitRun = useExitRun();
  useAfterCommit(executionId, () => {
    setSelectedNode(null);
  });

  // Superseded runs are the ones a newer start displaced. They are hidden by
  // default because a newest-wins workflow makes one on every reschedule, and a
  // builder opens this panel to see what ran, not what was replaced. Opening a
  // specific run via the URL includes them so a superseded id can still resolve.
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [returnFocusRunId, setReturnFocusRunId] = useState<string | null>(null);
  const includeSuperseded = showSuperseded || executionId !== undefined;

  const executionsQuery = useQuery({
    ...orpcQuery.workflow.getExecutions.queryOptions({
      input: {
        workflowId: currentWorkflowId ?? "",
        includeSuperseded,
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

  const listedIndex =
    executionId === undefined
      ? -1
      : executions.findIndex((execution) => execution.id === executionId);
  const listedRun = listedIndex >= 0 ? executions[listedIndex] : undefined;

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
  // long after there was anything left to learn about it. The logs payload also
  // carries an execution summary for ids past the newest-50 list.
  const detailQuery = useQuery({
    ...orpcQuery.workflow.getExecutionLogs.queryOptions({
      input: { executionId: executionId ?? "" },
      select: toExecutionDetail,
    }),
    enabled: executionId !== undefined,
    staleTime: 0,
    refetchInterval: detailPollInterval,
  });

  const eventsQuery = useQuery({
    ...orpcQuery.workflow.getExecutionEvents.queryOptions({
      input: { executionId: executionId ?? "" },
      select: toExecutionEvents,
    }),
    enabled: executionId !== undefined,
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

  const handleSelectRun = (id: string) => {
    setReturnFocusRunId(id);
    void navigate({ search: { executionId: id } });
  };

  if (executionsQuery.isPending && executionId === undefined) {
    return <RunsSkeleton />;
  }

  if (executionsQuery.isError && executionId === undefined) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <RunsListHeader />
        <div className="p-3">
          <p className="text-muted-foreground text-sm">
            Runs could not be loaded.
          </p>
          <Button
            className="mt-2"
            onClick={() => executionsQuery.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
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

  // Detail view is keyed off the search param. Ahead of the empty-list branch,
  // because a run being read keeps its view whether or not the list behind it
  // still holds a row for it.
  if (executionId !== undefined) {
    const execution = listedRun ?? detailQuery.data?.execution;
    if (!execution) {
      if (
        !detailQuery.isError &&
        (detailQuery.isPending || executionsQuery.isPending)
      ) {
        return <RunsSkeleton detail />;
      }

      return (
        <div className="flex h-full min-h-0 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <Button
              aria-label="Back to runs list"
              onClick={exitRun}
              size="sm"
              type="button"
              variant="ghost"
            >
              Back
            </Button>
            <h2 className="font-semibold text-sm">Run unavailable</h2>
          </header>
          <div className="p-3">
            <p className="text-muted-foreground text-sm">
              This run could not be loaded.
            </p>
            <Button
              className="mt-2"
              onClick={() => detailQuery.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        </div>
      );
    }

    const runNumber = listedIndex >= 0 ? executions.length - listedIndex : 0;

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
        onBack={exitRun}
        onCancel={(id) => cancelExecution.mutate({ executionId: id })}
        onResume={(token) => resumeWait.mutate({ token })}
        runNumber={runNumber}
        waits={detailQuery.data?.waits ?? []}
      />
    );
  }

  if (executions.length === 0) {
    return (
      <div
        className={cn(
          "flex h-full min-h-0 flex-col motion-reduce:animate-[run-panel-fade_100ms_ease-out]",
          returnFocusRunId
            ? "motion-safe:animate-[run-panel-back_160ms_cubic-bezier(0.16,1,0.3,1)]"
            : "motion-safe:animate-[run-panel-forward_200ms_cubic-bezier(0.16,1,0.3,1)]"
        )}
      >
        <RunsListHeader />
        <div className="min-h-0 flex-1 overflow-y-auto p-3 [scrollbar-gutter:stable_both-edges]">
          <div className="space-y-2">
            {supersededToggle}
            <WorkflowRefusedStarts refusedStarts={refusedStarts} />
            <div className="py-8 text-center">
              <p className="font-medium text-sm">No runs yet</p>
              <p className="mt-1 text-muted-foreground text-xs">
                Runs appear after this workflow starts.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // List view
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col motion-reduce:animate-[run-panel-fade_100ms_ease-out]",
        returnFocusRunId
          ? "motion-safe:animate-[run-panel-back_160ms_cubic-bezier(0.16,1,0.3,1)]"
          : "motion-safe:animate-[run-panel-forward_200ms_cubic-bezier(0.16,1,0.3,1)]"
      )}
    >
      <RunsListHeader />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 [scrollbar-gutter:stable_both-edges]">
        <div className="space-y-2 py-2">
          {supersededToggle}
          <WorkflowRefusedStarts refusedStarts={refusedStarts} />
        </div>
        <WorkflowRunsList
          executions={executions}
          focusId={returnFocusRunId}
          onSelect={handleSelectRun}
          selectedId={selectedExecutionId}
        />
      </div>
    </div>
  );
}
