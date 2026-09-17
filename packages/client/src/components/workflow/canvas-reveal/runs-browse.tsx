import { useAtomValue, useSetAtom } from "jotai";
import { useRef } from "react";
import { cn } from "@wfgraph/shared/utils";
import { RunsPanelActions } from "#src/components/workflow/node-config-panel";
import {
  runBrowseFocusRequestAtom,
  runEvidenceOriginAtom,
  useChooseRunExecution,
  useInspectRunLog,
  useRunGroupSummary,
  useRunNodeEvidence,
} from "#src/components/workflow/use-run-node-evidence";
import {
  type OpenRunIdentity,
  runRowFocusRequestAtom,
  useOpenRunIdentity,
  useWorkflowRuns,
} from "#src/components/workflow/use-workflow-runs";
import { WorkflowRunDetail } from "#src/components/workflow/workflow-run-detail";
import { WorkflowRunNodeEvidence } from "#src/components/workflow/workflow-run-node-evidence";
import {
  getStatusLabel,
  groupRunStatusTone,
  statusTone,
} from "#src/components/workflow/workflow-run-shared";
import {
  RunsEmptyState,
  RunsListNotices,
  RunsLoadFailure,
  RunsSkeleton,
  RunUnavailableMessage,
} from "#src/components/workflow/workflow-runs";
import { WorkflowRunsList } from "#src/components/workflow/workflow-runs-list";
import { useAfterCommit } from "#src/hooks/effects";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import { groupLabel } from "#src/lib/workflow-graph-types";
import {
  type WorkspaceAddress,
  workspaceAddressId,
  workspaceRouteSearch,
} from "#src/lib/workflow-navigation-state";
import { currentWorkflowNameAtom } from "#src/lib/workflow-save-store";
import {
  activeWorkspaceAddressAtom,
  clearRunNodeInspectionAtom,
  closeWorkspaceRevealAtom,
  inspectRunNodeAtom,
} from "#src/lib/workflow-workspace-navigation";
import {
  type GroupRunStatus,
  groupRunStatusLabel,
} from "@wfgraph/shared/graph/group-run-status";
import { RevealHeader, type RevealHeaderModel } from "./reveal-header";
import { RunsGroupSummary } from "./runs-group-summary";
import type {
  RevealBodyProps,
  RevealKind,
  RevealKindHeaderProps,
} from "./reveal-kinds";
import { useInspectorScroll } from "./use-inspector-scroll";

/** The Focus toggle's text on Runs, whose Focus shows a node's evidence. */
const RUNS_FOCUS_TOGGLE_TEXT = {
  browse: "Show evidence",
  focus: "Return to run",
};

/**
 * What the Runs header names past the run: nothing, the node whose evidence
 * Focus shows with that execution's status, or a Group frame with its run
 * status.
 */
type RunsHeaderTarget =
  | { kind: "run" }
  | { kind: "node"; title: string; status: string | null }
  | { kind: "group"; title: string; status: GroupRunStatus };

/**
 * The Runs header model. The run list names the workflow and Runs with no
 * Back. A run is titled by its number in the run list, or "Run" once it has
 * left the list, and carries its status and Back. A node or Group target adds
 * itself to the path and is titled by its name. A node carries the shown
 * execution's status, or "Not run" for a node with no execution, and a Group
 * carries its run status.
 */
function runsHeaderModel(input: {
  workflowName: string;
  openRun: OpenRunIdentity | null;
  target: RunsHeaderTarget;
}): RevealHeaderModel {
  const { workflowName, openRun, target } = input;
  const list: RevealHeaderModel = {
    workspaceLabel: "Runs",
    title: "Runs",
    path: [workflowName || "Untitled workflow", "Runs"],
    status: null,
    showsBack: false,
    focusToggleText: RUNS_FOCUS_TOGGLE_TEXT,
  };
  const runHeader = (
    title: string,
    status: RevealHeaderModel["status"]
  ): RevealHeaderModel => ({
    ...list,
    title,
    path: [...list.path, title],
    status,
    showsBack: true,
  });
  if (openRun === null) {
    return list;
  }
  if (openRun.kind === "run-loading") {
    return runHeader("Run", { text: "Loading", tone: "muted" });
  }
  if (openRun.kind === "run-unavailable") {
    return runHeader("Run unavailable", null);
  }
  const { execution, runNumber } = openRun;
  const run = runHeader(runNumber > 0 ? `Run #${runNumber}` : "Run", {
    text: getStatusLabel(execution.status),
    tone: statusTone(execution.status),
  });
  if (target.kind === "run") {
    return run;
  }
  return {
    ...run,
    title: target.title,
    path: [...run.path, target.title],
    status:
      target.kind === "group"
        ? {
            text: groupRunStatusLabel(target.status),
            tone: groupRunStatusTone(target.status),
          }
        : target.status === null
          ? { text: "Not run", tone: "muted" }
          : {
              text: getStatusLabel(target.status),
              tone: statusTone(target.status),
            },
  };
}

/**
 * The Runs header. It reads the run the route opens through the same cached
 * queries the Runs body observes, and a Group's status from the run status
 * projection, so it adds no request of its own. At Focus it names the node
 * from the same evidence the body shows.
 */
export function RunsHeader({
  subject,
  level,
  controls,
}: RevealKindHeaderProps) {
  const workflowName = useAtomValue(currentWorkflowNameAtom);
  const openRun = useOpenRunIdentity();
  const shownRun = openRun?.kind === "run" ? openRun : null;
  const { runsTarget } = subject;
  const evidence = useRunNodeEvidence(
    shownRun,
    runsTarget?.kind === "node" ? runsTarget.nodeId : null
  );
  const groupId =
    shownRun !== null && runsTarget?.kind === "group"
      ? runsTarget.groupId
      : null;
  const groupSummary = useRunGroupSummary(groupId);
  const groupFrame = useAtomValue(executionOverlayGraphAtom)?.nodes.find(
    (node) => node.id === groupId
  );
  const target: RunsHeaderTarget =
    level === "focus" && evidence !== null
      ? {
          kind: "node",
          title: evidence.title,
          status: evidence.shownExecution?.status ?? null,
        }
      : groupSummary !== null
        ? {
            kind: "group",
            title: groupLabel(groupFrame?.data.label),
            status: groupSummary.status,
          }
        : { kind: "run" };
  return (
    <RevealHeader
      controls={controls}
      level={level}
      model={runsHeaderModel({ workflowName, openRun, target })}
    />
  );
}

/**
 * Back and Escape on Runs. At Focus they return to the run's Browse and ask it
 * to focus the journey entry or canvas node that opened the evidence, or close
 * Reveal when a canvas click opened Focus from Closed. On a Group's summary
 * they close Reveal when a canvas click opened it from Closed, and otherwise
 * return to the run overview with focus on the Group card. In a Group's scope
 * they return to the overview scope with the Group card selected and its
 * summary shown. On the run overview they replace the route with the run list
 * and ask the list to focus that run's row; on the run list they close.
 */
export const unwindRuns: NonNullable<RevealKind["unwind"]> = ({
  subject,
  level,
  store,
  unwindLevel,
  returnFocusOnClose,
  replaceRouteSearch,
}) => {
  const address = store.get(activeWorkspaceAddressAtom);
  const { key, scope } = address;
  const target = subject.runsTarget;
  const stored = store.get(runEvidenceOriginAtom);
  const origin =
    target !== null &&
    stored?.addressId === workspaceAddressId(address) &&
    stored.nodeId === (target.kind === "node" ? target.nodeId : target.groupId)
      ? stored
      : null;
  const closeOpenedReveal = () => {
    if (origin === null || origin.closedReopenLevel === null) {
      return false;
    }
    // Closing through the address keeps the saved open or closed preference
    // as the person last chose it.
    store.set(runEvidenceOriginAtom, { ...origin, closedReopenLevel: null });
    returnFocusOnClose();
    store.set(closeWorkspaceRevealAtom, {
      address,
      reopenLevel: origin.closedReopenLevel,
    });
    return true;
  };
  if (level === "focus" && target?.kind === "node") {
    if (closeOpenedReveal()) {
      return;
    }
    store.set(runBrowseFocusRequestAtom, {
      nodeId: target.nodeId,
      logId: origin?.logId ?? null,
    });
    unwindLevel();
    return;
  }
  if (key.workspace !== "runs" || key.executionId === null) {
    unwindLevel();
    return;
  }
  if (target?.kind === "group") {
    if (closeOpenedReveal()) {
      return;
    }
    store.set(runBrowseFocusRequestAtom, {
      nodeId: target.groupId,
      logId: null,
    });
    store.set(clearRunNodeInspectionAtom);
    return;
  }
  if (scope.kind === "group") {
    const overview: WorkspaceAddress = {
      ...address,
      scope: { kind: "overview" },
    };
    store.set(inspectRunNodeAtom, {
      address: overview,
      nodeId: scope.groupId,
      executionLogId: null,
      selectsNode: true,
      opensFocus: false,
    });
    store.set(runBrowseFocusRequestAtom, {
      nodeId: scope.groupId,
      logId: null,
    });
    replaceRouteSearch(workspaceRouteSearch(overview));
    return;
  }
  store.set(runRowFocusRequestAtom, key.executionId);
  replaceRouteSearch({ view: "runs" });
};

/**
 * Runs in Canvas Reveal, at both levels. Browse shows the run list, or the run
 * the route opens with its summary, waits, exit and failure details, journey,
 * and activity. Focus shows the evidence of the node the run inspects. The run
 * overview stays mounted, hidden, while Focus shows, so returning keeps its
 * state; the run list's scroll and each overview's scroll are kept per address.
 */
export function RunsBody({ subject, frame, level }: RevealBodyProps) {
  const runs = useWorkflowRuns();
  const address = useAtomValue(activeWorkspaceAddressAtom);
  const focusRequest = useAtomValue(runBrowseFocusRequestAtom);
  const setFocusRequest = useSetAtom(runBrowseFocusRequestAtom);
  const setEvidenceOrigin = useSetAtom(runEvidenceOriginAtom);
  const inspectLog = useInspectRunLog();
  const chooseExecution = useChooseRunExecution();
  const rootRef = useRef<HTMLDivElement>(null);
  const overlayNodes = useAtomValue(executionOverlayGraphAtom)?.nodes ?? [];
  const { screen } = runs;
  const openRun = screen.kind === "run" ? screen : null;
  const { runsTarget } = subject;
  const evidence = useRunNodeEvidence(
    openRun === null
      ? null
      : { ...openRun.run, pinnedGraph: openRun.pinnedGraph },
    runsTarget?.kind === "node" ? runsTarget.nodeId : null
  );
  const evidenceScrollRef = useRef<HTMLDivElement>(null);
  const groupId =
    openRun !== null && runsTarget?.kind === "group"
      ? runsTarget.groupId
      : null;
  const groupSummary = useRunGroupSummary(groupId);
  const showsEvidence =
    openRun !== null && evidence !== null && level === "focus";
  // A Group frame has no evidence, so its summary replaces the run overview.
  const shownGroup =
    groupId !== null && groupSummary !== null
      ? { groupId, summary: groupSummary }
      : null;
  const showsScroller =
    screen.kind === "list" ||
    (openRun !== null && !showsEvidence && shownGroup === null);
  const {
    ref: scrollRef,
    onScroll,
    onScrollEnd,
    adoptScroll,
  } = useInspectorScroll(
    showsScroller
      ? {
          address,
          addressId: workspaceAddressId(address),
          inspectedId: null,
          level: "browse",
        }
      : null
  );

  // A focused row has scrolled the list to itself, and that position replaces
  // the stored one. With the row gone, the Reveal title takes focus.
  const answerRowFocus = (focused: boolean) => {
    runs.clearRowFocus();
    if (focused) {
      adoptScroll();
      return;
    }
    rootRef.current
      ?.closest('[data-slot="canvas-reveal"]')
      ?.querySelector<HTMLElement>('[data-slot="reveal-title"]')
      ?.focus();
  };

  // Leaving Focus for a canvas node hands DOM focus back to that node once the
  // overview shows again. A journey entry answers its own request below.
  const canvasFocusNodeId =
    showsScroller && focusRequest?.logId === null ? focusRequest.nodeId : null;
  useAfterCommit(canvasFocusNodeId, () => {
    if (canvasFocusNodeId === null) {
      return;
    }
    setFocusRequest(null);
    rootRef.current
      ?.closest('[data-slot="canvas-reveal"]')
      ?.parentElement?.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(canvasFocusNodeId)}"]`
      )
      ?.focus({ preventScroll: true });
  });

  // Choosing another execution of the same node keeps the evidence mounted, so
  // DOM focus stays on the control the person used; only the scroll starts over.
  const shownExecutionId = evidence?.shownExecution?.id ?? null;
  useAfterCommit(shownExecutionId, () => {
    if (evidenceScrollRef.current) {
      evidenceScrollRef.current.scrollTop = 0;
    }
  });

  // Reaching Browse by any path ends a Focus a canvas click opened from Closed,
  // so the next Back from Focus returns to Browse. A Group card click opens
  // Browse itself, so its record stays while its summary shows.
  useAfterCommit(`${level}:${groupId ?? ""}`, () => {
    if (level === "browse") {
      setEvidenceOrigin((origin) =>
        origin === null ||
        origin.closedReopenLevel === null ||
        origin.nodeId === groupId
          ? origin
          : { ...origin, closedReopenLevel: null }
      );
    }
  });

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="runs-browse"
      ref={rootRef}
    >
      {screen.kind === "loading-list" ? <RunsSkeleton /> : null}
      {screen.kind === "opening-newest" || screen.kind === "run-loading" ? (
        <RunsSkeleton detail />
      ) : null}
      {screen.kind === "run-unavailable" ? (
        <RunUnavailableMessage retry={screen.retry} />
      ) : null}
      {openRun !== null ? (
        <div
          className={cn("min-h-0 flex-1 flex-col", showsScroller && "flex")}
          hidden={!showsScroller}
        >
          <WorkflowRunDetail
            {...openRun.run}
            focusLogId={showsScroller ? (focusRequest?.logId ?? null) : null}
            focusSummaryOnMount={showsScroller && focusRequest === null}
            // A new run starts from its own journey selection and focus.
            key={openRun.run.execution.id}
            onFocusRestored={() => setFocusRequest(null)}
            onSelectLog={(log) => inspectLog(log, { opensFocus: true })}
            scroll={{ ref: scrollRef, onScroll, onScrollEnd }}
          />
        </div>
      ) : null}
      {openRun !== null && shownGroup !== null ? (
        <RunsGroupSummary
          groupId={shownGroup.groupId}
          // Each Group starts its summary from the top.
          key={shownGroup.groupId}
          logs={openRun.run.logs}
          nodes={overlayNodes}
          summary={shownGroup.summary}
        />
      ) : null}
      {openRun !== null && showsEvidence && evidence !== null ? (
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4 [scrollbar-gutter:stable]"
          // Each node starts its evidence from the top.
          key={evidence.nodeId}
          ref={evidenceScrollRef}
        >
          <WorkflowRunNodeEvidence
            evidence={evidence}
            isResuming={openRun.run.isResuming}
            onChooseExecution={(logId) =>
              chooseExecution(evidence.nodeId, logId)
            }
            onResume={openRun.run.onResume}
          />
        </div>
      ) : null}
      {screen.kind === "list" || screen.kind === "list-error" ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
          <p className="text-muted-foreground text-xs">
            Select a run to inspect its journey on the canvas.
          </p>
          <RunsPanelActions confirm={frame.confirm} />
        </div>
      ) : null}
      {screen.kind === "list-error" ? (
        <RunsLoadFailure retry={screen.retry} />
      ) : null}
      {screen.kind === "list" ? (
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 [scrollbar-gutter:stable_both-edges]"
          data-slot="runs-list-scroller"
          onScroll={onScroll}
          onScrollEnd={onScrollEnd}
          ref={scrollRef}
        >
          <div className="px-2 py-2">
            <RunsListNotices runs={runs}>
              {screen.executions.length === 0 ? <RunsEmptyState /> : null}
            </RunsListNotices>
          </div>
          <WorkflowRunsList
            executions={screen.executions}
            focusId={runs.focusRunId}
            onFocusAnswered={answerRowFocus}
            onSelect={runs.selectRun}
          />
        </div>
      ) : null}
    </div>
  );
}
