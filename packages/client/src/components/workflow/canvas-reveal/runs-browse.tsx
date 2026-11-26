import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useRef } from "react";
import { cn } from "@wfgraph/shared/utils";
import { runEvidenceOriginAtom } from "#src/components/workflow/run-evidence-origin";
import {
  runBrowseFocusRequestAtom,
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
  groupRunStatusTone,
  runStatusLabel,
  runStatusTone,
  stepRunStatusLabel,
} from "#src/components/workflow/workflow-run-shared";
import { runTitle } from "#src/components/workflow/workflow-run-summary-row";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { RunsSkeleton } from "#src/components/workflow/workflow-runs";
import { shownOutlineRow } from "#src/components/workflow/step-focus-landing";
import { useAfterCommit } from "#src/hooks/effects";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import { groupLabel } from "#src/lib/workflow-graph-types";
import {
  type RevealLevel,
  showsRunList,
  workspaceAddressId,
} from "#src/lib/workflow-navigation-state";
import {
  activeWorkspaceAddressAtom,
  clearRunNodeInspectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import {
  type GroupRunStatus,
  groupRunStatusLabel,
  type RunNodeEvidenceStatus,
} from "@wfgraph/shared/graph/group-run-status";
import { RevealHeader, type RevealHeaderModel } from "./reveal-header";
import { RunsGroupSummary } from "./runs-group-summary";
import type {
  MobileKindHeaderProps,
  RevealBodyProps,
  RevealKind,
  RevealKindHeaderProps,
} from "./reveal-kinds";
import { MobileSheetHeader } from "./mobile-sheet-header";
import type { RevealSubject } from "./reveal-subject";
import { useAddressBodyScroll } from "./use-address-body-scroll";

/** The phone's control that opens a run node's evidence over the run's sheet. */
const MOBILE_EVIDENCE_LABEL = "Show evidence";

/**
 * What the Runs header names past the run: nothing, the node whose evidence
 * Focus shows with that execution's status, or a Group frame with its run
 * status.
 */
type RunsHeaderTarget =
  | { kind: "run" }
  | {
      kind: "node";
      title: string;
      status: RunNodeEvidenceStatus;
      /** Whether the shown execution did nothing because the run is a test. */
      testSkipped: boolean;
    }
  | { kind: "group"; title: string; status: GroupRunStatus };

/**
 * A Runs header model with the name a phone sheet gives its Back button: the
 * level Back returns to, or null when the model offers no Back.
 */
type RunsHeaderModel = RevealHeaderModel & { backLabel: string | null };

/** An open run's header: its title and status, with Back to the run list. */
function runHeader(
  title: string,
  status: RevealHeaderModel["status"]
): RunsHeaderModel {
  return { title, name: null, status, showsBack: true, backLabel: "Runs" };
}

/**
 * The Runs header model. The run list is titled Runs with no Back. A run is
 * titled by `runTitle`, its Entity and start time, and carries its status and
 * Back, which a phone sheet names "Runs". A node or Group target is titled by
 * its name, with Back named for the run. A node carries the shown execution's
 * status, or "Not run" for a node with no execution, and a Group carries its
 * run status.
 */
function runsHeaderModel(input: {
  openRun: OpenRunIdentity | null;
  target: RunsHeaderTarget;
  catalog: ExtensionCatalog;
}): RunsHeaderModel {
  const { openRun, target, catalog } = input;
  const list: RunsHeaderModel = {
    title: "Runs",
    name: null,
    status: null,
    showsBack: false,
    backLabel: null,
  };
  if (openRun === null) {
    return list;
  }
  if (openRun.kind === "run-loading") {
    return runHeader("Run", { text: "Loading", tone: "muted" });
  }
  if (openRun.kind === "run-unavailable") {
    return runHeader("Run unavailable", null);
  }
  const { execution } = openRun;
  const run = runHeader(runTitle(execution, catalog), {
    text: runStatusLabel(execution.status),
    tone: runStatusTone(execution.status),
  });
  if (target.kind === "run") {
    return run;
  }
  return {
    ...run,
    title: target.title,
    backLabel: run.title,
    status:
      target.kind === "group"
        ? {
            text: groupRunStatusLabel(target.status),
            tone: groupRunStatusTone(target.status),
          }
        : stepRunStatusLabel(target.status, target.testSkipped),
  };
}

/**
 * The Runs header model for `subject` at `level`. It reads the run the route
 * opens through the same cached queries the Runs body observes, and a Group's
 * status from the run status projection, so it adds no request of its own. At
 * Focus it names the node from the same evidence the body shows.
 */
function useRunsHeaderModel(
  subject: RevealSubject,
  level: RevealLevel
): RunsHeaderModel {
  const catalog = useExtensionCatalog();
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
          status: evidence.status,
          testSkipped: evidence.testSkip !== null,
        }
      : groupSummary !== null
        ? {
            kind: "group",
            title: groupLabel(groupFrame?.data.label),
            status: groupSummary.status,
          }
        : { kind: "run" };
  return runsHeaderModel({ openRun, target, catalog });
}

/**
 * Opens the run list from an open run, the way Back from the run overview
 * does: the run's history entry is replaced by the list, and the list puts
 * focus on that run's row.
 */
export function useOpenRunList(): () => void {
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const address = useAtomValue(activeWorkspaceAddressAtom);
  const requestRowFocus = useSetAtom(runRowFocusRequestAtom);
  const executionId =
    address.key.workspace === "runs" ? address.key.executionId : null;
  return () => {
    requestRowFocus(executionId);
    void navigate({ search: { view: "runs" }, replace: true });
  };
}

/**
 * The Runs header on a mobile sheet, from the same model as `RunsHeader`. Back
 * is named for the level before the sheet's own, and a model with no Back
 * offers Close.
 */
export function RunsMobileHeader({ state, controls }: MobileKindHeaderProps) {
  const model = useRunsHeaderModel(
    state.subject,
    state.level === "full" ? "focus" : "browse"
  );
  return (
    <MobileSheetHeader
      backLabel={model.backLabel}
      controls={controls}
      fullSheetLabel={MOBILE_EVIDENCE_LABEL}
      name={null}
      status={model.status}
      title={model.title}
    />
  );
}

/** The Runs header in the Inspector, built from `useRunsHeaderModel`. */
export function RunsHeader({
  subject,
  level,
  controls,
}: RevealKindHeaderProps) {
  return (
    <RevealHeader
      controls={controls}
      model={useRunsHeaderModel(subject, level)}
    />
  );
}

/**
 * Back and Escape on Runs. At Focus they return to the run's Browse and ask it
 * to focus the journey entry or canvas node that opened the evidence. On a
 * Group's summary they return to the run overview with focus on the Group.
 * On the run overview they replace the
 * route with the run list and ask the list to focus that run's row. On the run
 * list they run the shell's own step back, which returns focus to the canvas.
 */
export const unwindRuns: NonNullable<RevealKind["unwind"]> = ({
  subject,
  level,
  store,
  unwindLevel,
  replaceRouteSearch,
}) => {
  const address = store.get(activeWorkspaceAddressAtom);
  const { key } = address;
  const target = subject.runsTarget;
  const stored = store.get(runEvidenceOriginAtom);
  const origin =
    target !== null &&
    stored?.addressId === workspaceAddressId(address) &&
    stored.nodeId === (target.kind === "node" ? target.nodeId : target.groupId)
      ? stored
      : null;
  if (level === "focus" && target?.kind === "node") {
    store.set(runBrowseFocusRequestAtom, {
      nodeId: target.nodeId,
      logId: origin?.logId ?? null,
      fromOutline: origin?.fromOutline === true,
    });
    unwindLevel();
    return;
  }
  if (key.workspace !== "runs" || showsRunList(key)) {
    unwindLevel();
    return;
  }
  if (target?.kind === "group") {
    store.set(runBrowseFocusRequestAtom, {
      nodeId: target.groupId,
      logId: null,
    });
    store.set(clearRunNodeInspectionAtom);
    return;
  }
  store.set(runRowFocusRequestAtom, key.executionId);
  replaceRouteSearch({ view: "runs" });
};

/**
 * Runs in the Inspector, at both levels. Browse shows the run the route
 * opens with its summary, waits, exit and failure details, journey, and
 * activity. With no run open a phone's sheet shows a line pointing at the run
 * list; at `md` and wider the run list opens no Inspector. Focus shows the evidence of the node the run inspects. The run
 * overview stays mounted, hidden, while Focus shows, so returning keeps its
 * state; each overview's scroll is kept per address.
 */
export function RunsBody({ subject, level, mobile }: RevealBodyProps) {
  const runs = useWorkflowRuns();
  const address = useAtomValue(activeWorkspaceAddressAtom);
  const focusRequest = useAtomValue(runBrowseFocusRequestAtom);
  const setFocusRequest = useSetAtom(runBrowseFocusRequestAtom);
  const inspectLog = useInspectRunLog();
  const chooseExecution = useChooseRunExecution();
  const overlayNodes = useAtomValue(executionOverlayGraphAtom)?.nodes ?? [];
  const { screen } = runs;
  const openRun = screen.kind === "run" ? screen : null;
  const { runsTarget } = subject;
  const evidence = useRunNodeEvidence(
    openRun === null
      ? null
      : {
          ...openRun.run,
          pinnedGraph: openRun.pinnedGraph,
          schedule: openRun.run.executor?.schedule ?? null,
        },
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
    openRun !== null && !showsEvidence && shownGroup === null;
  const {
    ref: scrollRef,
    onScroll,
    onScrollEnd,
  } = useAddressBodyScroll(showsScroller ? address : null, mobile);

  // Leaving Focus hands DOM focus back to what opened the evidence once the
  // overview shows again: the node's row in the run's outline, or its canvas
  // card.
  const returnFocusNodeId =
    showsScroller && focusRequest !== null ? focusRequest.nodeId : null;
  const returnsToRow = focusRequest?.fromOutline === true;
  useAfterCommit(returnFocusNodeId, () => {
    if (returnFocusNodeId === null) {
      return;
    }
    setFocusRequest(null);
    const card = () =>
      document.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(returnFocusNodeId)}"]`
      );
    (returnsToRow
      ? (shownOutlineRow(returnFocusNodeId) ?? card())
      : card()
    )?.focus({ preventScroll: true });
  });

  // Choosing another execution of the same node keeps the evidence mounted, so
  // DOM focus stays on the control the person used; only the scroll starts over.
  const shownExecutionId = evidence?.shownExecution?.id ?? null;
  useAfterCommit(shownExecutionId, () => {
    if (evidenceScrollRef.current) {
      evidenceScrollRef.current.scrollTop = 0;
    }
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="runs-browse">
      {screen.kind === "run-loading" ? <RunsSkeleton detail /> : null}
      {openRun !== null ? (
        <div
          className={cn("min-h-0 flex-1 flex-col", showsScroller && "flex")}
          hidden={!showsScroller}
        >
          <WorkflowRunDetail
            {...openRun.run}
            focusSummaryOnMount={showsScroller && focusRequest === null}
            // A new run starts from its own journey selection and focus.
            key={openRun.run.execution.id}
            onSelectLog={inspectLog}
            scroll={{ ref: scrollRef, onScroll, onScrollEnd }}
          />
        </div>
      ) : null}
      {openRun !== null && shownGroup !== null ? (
        <RunsGroupSummary
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
            isContinuing={openRun.run.isContinuing}
            onChooseExecution={(logId) =>
              chooseExecution(evidence.nodeId, logId)
            }
            onResume={openRun.run.onResume}
            onContinueWait={openRun.run.onContinueWait}
          />
        </div>
      ) : null}
      {screen.kind === "list" ||
      screen.kind === "list-error" ||
      screen.kind === "loading-list" ||
      screen.kind === "run-unavailable" ? (
        // The run list, its loading and failure states, and a run that could
        // not be loaded are the outline's, so this body says where to go. Only
        // a phone's run list sheet and a run that failed to load reach it.
        <p className="px-3 py-3 text-muted-foreground text-sm">
          {screen.kind === "run-unavailable"
            ? "This run's summary shows here once it loads."
            : "Open a run from the list to see its summary here."}
        </p>
      ) : null}
    </div>
  );
}
