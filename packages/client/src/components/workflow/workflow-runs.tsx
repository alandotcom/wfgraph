import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
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
} from "#src/lib/execution-logs";
import { orpcQuery, refreshRunHistory } from "#src/lib/rpc-query";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import { toEditorEdge, toEditorNode } from "#src/lib/workflow-graph-types";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  propertiesPanelActiveTabAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";
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

const LEFT_THE_LIST_NOTICE =
  "This run has left the runs list, so what it shows stops here. A newer start supersedes the runs going for the same entity, and the list holds the newest 50.";

const workflowRouteApi = getRouteApi("/workflows/$workflowId");

export function WorkflowRuns() {
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const [selectedExecutionId, setSelectedExecutionId] = useAtom(
    selectedExecutionIdAtom
  );
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const queryClient = useQueryClient();
  // Which run is open is URL state (TanStack Router search params), not a
  // local mirror of a one-shot deep link.
  const { executionId } = workflowRouteApi.useSearch();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });

  // Superseded runs are the ones a newer start displaced. They are hidden by
  // default because a newest-wins workflow makes one on every reschedule, and a
  // builder opens this panel to see what ran, not what was replaced. Opening a
  // specific run via the URL includes them so a superseded id can still resolve.
  const [showSuperseded, setShowSuperseded] = useState(false);
  const includeSuperseded = showSuperseded || executionId !== undefined;
  const setExecutionOverlay = useSetAtom(executionOverlayGraphAtom);

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

  // URL search owns which run is open. One sync: selection, Runs tab, and the
  // pinned-graph overlay. Paint only when the run's workflowId matches the
  // hydrated editor (`currentWorkflowId`) — never before, or a late hydrate
  // clears the overlay while the key stays `ready` and the canvas sticks on
  // the draft. Key is closed | open:exec:wf | ready:exec:wf; never fetch
  // timestamps, so a logs poll cannot rebuild nodes as idle and wipe statuses.
  // `graph` is always on a successful logs payload; absence means the query
  // has not landed yet.
  const detail = detailQuery.data;
  const executionWorkflowId = detail?.execution.workflowId;
  const workflowAligned =
    detail !== undefined && executionWorkflowId === currentWorkflowId;
  useAfterCommit(
    executionId === undefined
      ? "closed"
      : workflowAligned
        ? `ready:${executionId}:${currentWorkflowId}`
        : `open:${executionId}:${currentWorkflowId ?? ""}`,
    () => {
      if (executionId === undefined) {
        setSelectedExecutionId(null);
        setExecutionOverlay(null);
        return;
      }

      setActiveTab("runs");
      setSelectedExecutionId(executionId);

      if (!workflowAligned || detail === undefined) {
        // Stay selection-only until hydrate and the run agree; drop any stale
        // overlay from the previous workflow rather than paint-then-lose.
        setExecutionOverlay(null);
        return;
      }

      const graphData = toWorkflowGraphData(detail.graph);
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
    }
  );

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
    void navigate({ search: { executionId: id } });
  };

  const handleBack = () => {
    void navigate({ search: {} });
  };

  if (executionsQuery.isPending && executionId === undefined) {
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
        return (
          <div className="flex items-center justify-center py-12">
            <Spinner />
          </div>
        );
      }

      return (
        <div className="space-y-2 px-1 py-2">
          <Button
            aria-label="Back to runs list"
            onClick={handleBack}
            size="sm"
            type="button"
            variant="ghost"
          >
            Back
          </Button>
          <p className="text-muted-foreground text-sm">
            This run could not be loaded.
          </p>
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
        onBack={handleBack}
        onCancel={(id) => cancelExecution.mutate({ executionId: id })}
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
