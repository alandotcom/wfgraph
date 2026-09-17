import { useAtomValue } from "jotai";
import { useRef } from "react";
import { RunsPanelActions } from "#src/components/workflow/node-config-panel";
import {
  type OpenRunIdentity,
  runRowFocusRequestAtom,
  useOpenRunIdentity,
  useWorkflowRuns,
} from "#src/components/workflow/use-workflow-runs";
import { WorkflowRunDetail } from "#src/components/workflow/workflow-run-detail";
import {
  getStatusLabel,
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
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import { workspaceAddressId } from "#src/lib/workflow-navigation-state";
import { currentWorkflowNameAtom } from "#src/lib/workflow-save-store";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import { RevealHeader, type RevealHeaderModel } from "./reveal-header";
import type {
  RevealBodyProps,
  RevealKind,
  RevealKindHeaderProps,
} from "./reveal-kinds";
import { useInspectorScroll } from "./use-inspector-scroll";

/**
 * The Runs header model. The run list names the workflow and Runs with no
 * Back. A run is titled by its number in the run list, or "Run" once it has
 * left the list, and carries its status and Back.
 */
function runsHeaderModel(
  workflowName: string,
  openRun: OpenRunIdentity | null
): RevealHeaderModel {
  const list: RevealHeaderModel = {
    workspaceLabel: "Runs",
    title: "Runs",
    path: [workflowName || "Untitled workflow", "Runs"],
    status: null,
    showsBack: false,
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
  return runHeader(runNumber > 0 ? `Run #${runNumber}` : "Run", {
    text: getStatusLabel(execution.status),
    tone: statusTone(execution.status),
  });
}

/**
 * The Runs header. It reads the run the route opens through the same cached
 * queries the Runs body observes, so it adds no request of its own.
 */
export function RunsHeader({ level, controls }: RevealKindHeaderProps) {
  const workflowName = useAtomValue(currentWorkflowNameAtom);
  const openRun = useOpenRunIdentity();
  return (
    <RevealHeader
      controls={controls}
      level={level}
      model={runsHeaderModel(workflowName, openRun)}
    />
  );
}

/**
 * Back and Escape on Runs. On an open run they replace the route with the run
 * list and ask the list to focus that run's row; on the run list they close.
 */
export const unwindRuns: NonNullable<RevealKind["unwind"]> = ({
  store,
  unwindLevel,
  replaceRouteSearch,
}) => {
  const { key } = store.get(activeWorkspaceAddressAtom);
  if (key.workspace !== "runs" || key.executionId === null) {
    unwindLevel();
    return;
  }
  store.set(runRowFocusRequestAtom, key.executionId);
  replaceRouteSearch({ view: "runs" });
};

/**
 * Runs in Canvas Reveal's Browse: the run list, or the run the route opens with
 * its summary, waits, exit and failure details, journey, and activity. A node
 * selected on the run's canvas shows its evidence in place of the overview. The
 * run list's scroll and each run overview's scroll are kept per address.
 */
export function RunsBrowse({ frame }: RevealBodyProps) {
  const runs = useWorkflowRuns();
  const address = useAtomValue(activeWorkspaceAddressAtom);
  const inspectsNode = useAtomValue(selectedNodeAtom) !== null;
  const rootRef = useRef<HTMLDivElement>(null);
  const { screen } = runs;
  const showsScroller =
    screen.kind === "list" || (screen.kind === "run" && !inspectsNode);
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
      {screen.kind === "run" ? (
        <WorkflowRunDetail
          {...screen.run}
          // A new run starts from its own journey selection and focus.
          key={screen.run.execution.id}
          scroll={{ ref: scrollRef, onScroll, onScrollEnd }}
        />
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
