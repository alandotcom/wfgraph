import {
  keepPreviousData,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { atom, useAtom, useAtomValue, useAtomValueRawSync } from "jotai";
import {
  type CancelNotDelivered,
  type ExecutionEvent,
  type ExecutionLog,
  type ExecutionWait,
  isRunInProgress,
  type RefusedStart,
  shouldPollExecutionDetail,
  toExecutionDetail,
  toExecutionEvents,
  toWorkflowExecutions,
  type WorkflowExecution,
} from "#src/lib/execution-logs";
import { useAfterCommit } from "#src/hooks/effects";
import { orpcQuery, refreshRunHistory } from "#src/lib/rpc-query";
import { can } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { PinnedGraphState } from "#src/lib/run-node-evidence";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { selectedExecutionIdAtom } from "#src/lib/workflow-ui-store";
import {
  activeShowSupersededAtom,
  hasNamedRunAtom,
} from "#src/lib/workflow-workspace-navigation";
import type { WorkflowRunDetailProps } from "./workflow-run-detail";

/** How often a run that is still going gets re-read. */
export const RUN_POLL_MS = 2000;

const LEFT_THE_LIST_NOTICE =
  "This run is no longer in the runs list. The list shows the newest 50 runs, and a newer start replaces runs in progress for the same entity.";

/**
 * The run whose row takes focus the next time the run list shows it. Leaving
 * a run sets it, and the run list clears it once it has looked for the row.
 */
export const runRowFocusRequestAtom = atom<string | null>(null);

/**
 * What an open run's detail view shows, before a frame adds its Back, its
 * journey handling, its focus requests, and its scroll.
 */
export type OpenRun = Omit<
  WorkflowRunDetailProps,
  | "scroll"
  | "onSelectLog"
  | "focusLogId"
  | "onFocusRestored"
  | "focusSummaryOnMount"
>;

/**
 * Which run the route opens, as far as the reads know it. `run` carries the
 * execution from the run list, or from its logs once it has left the list, its
 * number in the list, which is 0 for a run the list does not hold, the logs,
 * waits, and events read so far, and whether its pinned graph is on the canvas.
 */
export type OpenRunIdentity =
  | { kind: "run-loading" }
  | { kind: "run-unavailable"; retry: () => void }
  | {
      kind: "run";
      execution: WorkflowExecution;
      runNumber: number;
      listed: boolean;
      logs: ExecutionLog[];
      waits: ExecutionWait[];
      events: ExecutionEvent[];
      pinnedGraph: PinnedGraphState;
    };

/**
 * What the Runs surface shows. The run list and one run are the two resolved
 * screens; each other screen is a loading or failure state on the way to one.
 * `opening-newest` holds while the newest run is being opened by itself. A
 * `list` whose `settled` is false shows the rows of the previous query while
 * the current one loads.
 */
export type WorkflowRunsScreen =
  | { kind: "loading-list" }
  | { kind: "opening-newest" }
  | { kind: "list-error"; retry: () => void }
  | { kind: "list"; executions: WorkflowExecution[]; settled: boolean }
  | { kind: "run-loading" }
  | { kind: "run-unavailable"; retry: () => void }
  | { kind: "run"; run: OpenRun; pinnedGraph: PinnedGraphState };

export type WorkflowRunsState = {
  screen: WorkflowRunsScreen;
  /** How many runs a newer start superseded, which the list hides by default. */
  supersededCount: number;
  showSuperseded: boolean;
  toggleSuperseded: () => void;
  refusedStarts: RefusedStart[];
  cancelNotDelivered: CancelNotDelivered[];
  /**
   * The run row to focus, once the run list shows its settled rows, or null.
   * The list calls `clearRowFocus` after it has looked for the row.
   */
  focusRunId: string | null;
  clearRowFocus: () => void;
  /**
   * Open one run from the list. The navigation pushes a history entry, and
   * applying the route carries a mobile Reveal sequence from the list to the
   * run.
   */
  selectRun: (executionId: string) => void;
};

/** What `useRunReads` hands the Runs header and the Runs body. */
export interface RunReads {
  currentWorkflowId: string | null;
  /** The run the route opens, or undefined while the route names the run list. */
  executionId: string | undefined;
  executionsQuery: UseQueryResult<ReturnType<typeof toWorkflowExecutions>>;
  /** The listed runs, newest first, or empty while the list has not loaded. */
  executions: WorkflowExecution[];
  /** The open run's row in the run list, when the list holds one. */
  listedRun: WorkflowExecution | undefined;
  detailQuery: UseQueryResult<ReturnType<typeof toExecutionDetail>>;
  openRunIdentity: () => OpenRunIdentity;
}

/**
 * The run list and open-run reads that the Runs header and the Runs body both
 * observe: the list, the open run's logs and events, and whether its pinned
 * graph read failed. Each caller builds the same query keys and options here,
 * so the cache answers both from one request and one polling interval.
 */
function useRunReads(): RunReads {
  // Route synchronization can write these before normal subscriptions mount.
  const currentWorkflowId = useAtomValueRawSync(currentWorkflowIdAtom);
  // Which run is open is URL state, read through the active workspace address
  // that Canvas Reveal and its scroll are keyed by, so the screen and the
  // address change in the same render. ExecutionOverlaySync pins the graph.
  const executionId = useAtomValueRawSync(selectedExecutionIdAtom) ?? undefined;
  const showSuperseded = useAtomValueRawSync(activeShowSupersededAtom);
  const canReadList = can(WfGraphOperations.workflowGetExecutions.id);
  const canReadLogs = can(WfGraphOperations.workflowGetExecutionLogs.id);
  const canReadEvents = can(WfGraphOperations.workflowGetExecutionEvents.id);
  const canReadVersionGraph = can(WfGraphOperations.workflowGetVersionGraph.id);
  const overlayGraph = useAtomValue(executionOverlayGraphAtom);

  // Superseded runs are the ones a newer start displaced. They are hidden by
  // default because a newest-wins workflow makes one on every reschedule, and a
  // builder opens Runs to see what ran. Opening a specific run via the URL
  // includes them so a superseded id can still resolve.
  const executionsQuery = useQuery({
    ...orpcQuery.workflow.getExecutions.queryOptions({
      input: {
        workflowId: currentWorkflowId ?? "",
        includeSuperseded: showSuperseded || executionId !== undefined,
      },
      select: toWorkflowExecutions,
    }),
    enabled: currentWorkflowId !== null && canReadList,
    staleTime: 0,
    refetchInterval: RUN_POLL_MS,
    // Toggling the superseded rows changes the query key, and without this the
    // surface would unmount its own list and flash the empty state on the
    // click that asked to see more of it.
    placeholderData: keepPreviousData,
  });

  const executions = executionsQuery.data?.executions ?? [];
  const listedIndex =
    executionId === undefined
      ? -1
      : executions.findIndex((execution) => execution.id === executionId);
  const listedRun: WorkflowExecution | undefined =
    listedIndex >= 0 ? executions[listedIndex] : undefined;

  // The list is already polling, so its status controls whether the logs still
  // have active work to learn about. A run that has left the list reports no
  // status, which stops this interval. Cancel therefore has to invalidate logs
  // and events in `refreshRunHistory`: a list-only refresh would otherwise
  // leave the journey on its last in-flight snapshot.
  // Opening a run enables its logs and events; the cache decides whether that
  // means a request. The logs payload also carries an execution summary for ids
  // past the newest-50 list. Once loaded, that summary owns polling so a deep
  // link outside the list and a list/detail terminal-write race both converge.
  const detailQuery = useQuery({
    ...orpcQuery.workflow.getExecutionLogs.queryOptions({
      input: { executionId: executionId ?? "" },
      select: toExecutionDetail,
    }),
    enabled: executionId !== undefined && canReadLogs,
    staleTime: 0,
    refetchInterval: (query) =>
      shouldPollExecutionDetail(
        query.state.data?.execution.status,
        listedRun?.status
      )
        ? RUN_POLL_MS
        : false,
  });

  const detailStatus = detailQuery.data?.execution.status ?? listedRun?.status;
  const eventsQuery = useQuery({
    ...orpcQuery.workflow.getExecutionEvents.queryOptions({
      input: { executionId: executionId ?? "" },
      select: toExecutionEvents,
    }),
    enabled: executionId !== undefined && canReadEvents,
    staleTime: 0,
    refetchInterval: isRunInProgress(detailStatus) ? RUN_POLL_MS : false,
  });

  // `ExecutionOverlaySync` reads the pinned graph and puts it on the canvas.
  // This observer never fetches; it reports whether that read failed.
  const versionGraphQuery = useQuery({
    ...orpcQuery.workflow.getVersionGraph.queryOptions({
      input: {
        versionId: detailQuery.data?.execution.workflowVersionId ?? "",
      },
    }),
    enabled: false,
  });
  const pinnedGraph: PinnedGraphState =
    overlayGraph !== null
      ? "ready"
      : !canReadVersionGraph || versionGraphQuery.isError
        ? "unavailable"
        : "loading";

  const identity = (): OpenRunIdentity => {
    // A run being read keeps its view whether or not the list behind it still
    // holds a row for it.
    const execution = listedRun ?? detailQuery.data?.execution;
    if (!execution) {
      return !detailQuery.isError &&
        (detailQuery.isPending || executionsQuery.isPending)
        ? { kind: "run-loading" }
        : { kind: "run-unavailable", retry: () => void detailQuery.refetch() };
    }
    return {
      kind: "run",
      execution,
      runNumber: listedIndex >= 0 ? executions.length - listedIndex : 0,
      listed: listedRun !== undefined,
      logs: detailQuery.data?.logs ?? [],
      waits: detailQuery.data?.waits ?? [],
      events: eventsQuery.data ?? [],
      pinnedGraph,
    };
  };

  return {
    currentWorkflowId,
    executionId,
    executionsQuery,
    executions,
    listedRun,
    detailQuery,
    openRunIdentity: identity,
  };
}

/** The run the route opens, or null while the route names the run list. */
export function useOpenRunIdentity(): OpenRunIdentity | null {
  const reads = useRunReads();
  return reads.executionId === undefined ? null : reads.openRunIdentity();
}

/**
 * The Runs surface's reads, writes, and screen, for the run the route names.
 * The run list polls, and an open run's logs and events poll while it is in
 * progress. A Runs visit that has never named a run opens the newest run,
 * replacing the history entry. Every read is keyed by workflow or execution
 * id, so a late response for another run never reaches the open run's screen.
 */
export function useWorkflowRuns(): WorkflowRunsState {
  const reads = useRunReads();
  const { currentWorkflowId, executionId, executionsQuery, executions } = reads;
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const canCancel = can(WfGraphOperations.workflowCancelExecution.id);
  const canResume = can(WfGraphOperations.workflowResumeWait.id);
  // Workspace navigation records whether a route has named a run of this
  // workflow. The surface unmounts outside Runs, so a value held here would
  // forget the run closed before leaving and reopen the newest on return.
  const hasNamedRun = useAtomValue(hasNamedRunAtom);
  const [showSuperseded, setShowSuperseded] = useAtom(activeShowSupersededAtom);
  const [focusRequest, setFocusRequest] = useAtom(runRowFocusRequestAtom);

  const shouldSelectInitialRun =
    executionId === undefined &&
    currentWorkflowId !== null &&
    !hasNamedRun &&
    executionsQuery.isSuccess;
  const initialRunId = shouldSelectInitialRun ? executions[0]?.id : undefined;

  useAfterCommit(initialRunId, () => {
    if (!shouldSelectInitialRun) {
      return;
    }

    // Opening the newest run is automatic, so it replaces the run list's
    // history entry, and Back from the run returns to the page before Runs.
    if (initialRunId) {
      void navigate({
        search: { view: "runs", executionId: initialRunId },
        replace: true,
      });
    }
  });

  // No `errorMessage`, so the cache toasts what the server said. Cancel refuses
  // for reasons the operator has to tell apart: a run an earlier Cancel Event
  // already claimed, and a run that finished first. A blanket message would
  // render both as one sentence that names neither.
  const cancelExecution = useMutation(
    orpcQuery.workflow.cancelExecution.mutationOptions({
      onSuccess: () => refreshRunHistory(queryClient),
    })
  );

  const resumeWait = useMutation(
    orpcQuery.workflow.resumeWait.mutationOptions({
      onSuccess: () => refreshRunHistory(queryClient),
      meta: { errorMessage: "Failed to resume the run" },
    })
  );

  const listScreen = (): WorkflowRunsScreen => {
    if (executionsQuery.isPending) {
      return { kind: "loading-list" };
    }
    // The initial destination is the newest run. Keep its placeholder in place
    // until the URL catches up, rather than flashing the list beforehand.
    if (initialRunId) {
      return { kind: "opening-newest" };
    }
    if (executionsQuery.isError) {
      return {
        kind: "list-error",
        retry: () => void executionsQuery.refetch(),
      };
    }
    return {
      kind: "list",
      executions,
      settled: !executionsQuery.isPlaceholderData,
    };
  };

  const openRunScreen = (): WorkflowRunsScreen => {
    const identity = reads.openRunIdentity();
    if (identity.kind !== "run") {
      return identity;
    }
    const { execution, waits } = identity;
    return {
      kind: "run",
      pinnedGraph: identity.pinnedGraph,
      run: {
        execution,
        runNumber: identity.runNumber,
        notice: identity.listed ? undefined : LEFT_THE_LIST_NOTICE,
        logs: identity.logs,
        events: identity.events,
        exit: reads.detailQuery.data?.exit ?? null,
        waits,
        isCanceling:
          cancelExecution.isPending &&
          cancelExecution.variables?.executionId === execution.id,
        isResuming:
          resumeWait.isPending &&
          waits.some(
            (wait) => wait.resumeToken === resumeWait.variables?.token
          ),
        onCancel: canCancel
          ? (id) => cancelExecution.mutate({ executionId: id })
          : undefined,
        onResume: canResume
          ? (token) => resumeWait.mutate({ token })
          : undefined,
      },
    };
  };

  const screen = executionId === undefined ? listScreen() : openRunScreen();

  return {
    screen,
    supersededCount: executionsQuery.data?.supersededCount ?? 0,
    showSuperseded,
    toggleSuperseded: () => setShowSuperseded(!showSuperseded),
    refusedStarts: executionsQuery.data?.refusedStarts ?? [],
    cancelNotDelivered: executionsQuery.data?.cancelNotDelivered ?? [],
    focusRunId: screen.kind === "list" && screen.settled ? focusRequest : null,
    clearRowFocus: () => setFocusRequest(null),
    selectRun: (id) => {
      void navigate({ search: { view: "runs", executionId: id } });
    },
  };
}
