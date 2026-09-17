import { useSetAtom } from "jotai";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useAfterCommit } from "#src/hooks/effects";
import { Button } from "#src/components/ui/button";
import type { PinnedGraphState } from "#src/lib/run-node-evidence";
import { clearRunNodeInspectionAtom } from "#src/lib/workflow-workspace-navigation";
import {
  useChooseRunExecution,
  useInspectRunLog,
  useRunNodeEvidence,
} from "./use-run-node-evidence";
import { WorkflowCancellationFailures } from "./workflow-cancellation-failures";
import { WorkflowRefusedStarts } from "./workflow-refused-starts";
import { WorkflowRunDetail } from "./workflow-run-detail";
import { WorkflowRunNodeEvidence } from "./workflow-run-node-evidence";
import {
  getStatusLabel,
  getStatusTextClass,
  nodeKindLabel,
} from "./workflow-run-shared";
import { WorkflowRunsList } from "./workflow-runs-list";
import {
  type OpenRun,
  useWorkflowRuns,
  type WorkflowRunsState,
} from "./use-workflow-runs";

/**
 * The row cap the server reads under, mirrored here for one sentence only: past
 * this many superseded runs, showing them cannot show them all, and a label that
 * promised otherwise would be a lie a builder could count.
 */
const EXECUTIONS_PAGE_CAP = 50;

export function RunsSkeleton({ detail = false }: { detail?: boolean }) {
  return (
    <div
      aria-label="Loading runs"
      aria-busy="true"
      className="flex h-full min-h-0 flex-col"
    >
      <div className="shrink-0 space-y-2 border-b px-3 py-3">
        <div className="h-4 w-2/3 rounded-sm bg-muted" />
        <div className="h-3 w-1/2 rounded-sm bg-muted" />
        {detail ? <div className="mt-3 h-16 rounded-sm bg-muted/70" /> : null}
      </div>
      <div className="min-h-0 flex-1 px-3 py-2">
        {Array.from({ length: detail ? 4 : 6 }, (_, index) => (
          <div className="flex h-13 items-center gap-3 border-b" key={index}>
            <div className="size-2 rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-2/3 rounded-sm bg-muted" />
              <div className="h-2.5 w-1/2 rounded-sm bg-muted/70" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The run list failed to load, with a Retry that reads it again. */
export function RunsLoadFailure({ retry }: { retry: () => void }) {
  return (
    <div className="p-3">
      <p className="text-muted-foreground text-sm">Runs could not be loaded.</p>
      <Button
        className="mt-2"
        onClick={retry}
        size="sm"
        type="button"
        variant="outline"
      >
        Retry
      </Button>
    </div>
  );
}

/** The run the route names could not be read, with a Retry. */
export function RunUnavailableMessage({ retry }: { retry: () => void }) {
  return (
    <div className="p-3">
      <p className="text-muted-foreground text-sm">
        This run could not be loaded.
      </p>
      <Button
        className="mt-2"
        onClick={retry}
        size="sm"
        type="button"
        variant="outline"
      >
        Retry
      </Button>
    </div>
  );
}

/**
 * What sits above the run rows: the superseded count and its Show or Hide, the
 * Refused Starts, and the Cancellation Failures, followed by `children`.
 */
export function RunsListNotices({
  runs,
  children,
}: {
  runs: WorkflowRunsState;
  children?: ReactNode;
}) {
  const { supersededCount } = runs;
  return (
    <div className="space-y-2">
      {supersededCount > 0 ? (
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
            onClick={runs.toggleSuperseded}
            size="sm"
            type="button"
            variant="ghost"
          >
            {runs.showSuperseded ? "Hide" : "Show"}
          </Button>
        </div>
      ) : null}
      <WorkflowRefusedStarts refusedStarts={runs.refusedStarts} />
      <WorkflowCancellationFailures
        cancelNotDelivered={runs.cancelNotDelivered}
      />
      {children}
    </div>
  );
}

export function RunsEmptyState() {
  return (
    <div className="py-8 text-center">
      <p className="font-medium text-sm">No runs yet</p>
      <p className="mt-1 text-muted-foreground text-xs">
        Runs appear after this workflow starts.
      </p>
    </div>
  );
}

function RunsListHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className="flex shrink-0 items-start justify-between gap-2 border-b bg-background px-3 py-3">
      <div>
        <h2 className="font-semibold text-sm">Execution Inspector</h2>
        <p className="mt-0.5 text-muted-foreground text-xs">
          Select a run to inspect its journey on the canvas.
        </p>
      </div>
      {actions}
    </header>
  );
}

/**
 * One open run in the configuration sheet: its overview, or, in its place, the
 * evidence of the node the run inspects. The evidence heading takes focus when
 * the node or execution it shows changes. Back from the evidence clears the
 * canvas selection and returns focus to the journey entry that opened it.
 */
function SheetRun({
  run,
  pinnedGraph,
  onBack,
}: {
  run: OpenRun;
  pinnedGraph: PinnedGraphState;
  onBack: () => void;
}) {
  const evidence = useRunNodeEvidence({ ...run, pinnedGraph });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const inspectLog = useInspectRunLog();
  const chooseExecution = useChooseRunExecution();
  const clearInspection = useSetAtom(clearRunNodeInspectionAtom);
  // The journey entry that opened the evidence, which takes focus on the way
  // back while the evidence still shows that entry's node.
  const [journeyOrigin, setJourneyOrigin] = useState<{
    nodeId: string;
    logId: string;
  } | null>(null);
  const [returnFocusLogId, setReturnFocusLogId] = useState<string | null>(null);

  const shownKey =
    evidence === null
      ? null
      : `${evidence.nodeId}|${evidence.shownExecution?.id ?? ""}`;
  useAfterCommit(shownKey, () => {
    if (shownKey !== null) {
      headingRef.current?.focus();
    }
  });

  if (evidence === null) {
    return (
      <WorkflowRunDetail
        {...run}
        focusLogId={returnFocusLogId}
        focusSummaryOnMount={returnFocusLogId === null}
        onBack={onBack}
        onFocusRestored={() => setReturnFocusLogId(null)}
        onSelectLog={(log) => {
          setJourneyOrigin({ nodeId: log.nodeId, logId: log.id });
          inspectLog(log, { opensFocus: false });
        }}
      />
    );
  }

  const { shownExecution } = evidence;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b bg-background px-3 py-3">
        <div className="flex min-w-0 items-center gap-1">
          <Button
            aria-label="Back to run overview"
            className="-ml-1 max-md:size-11"
            onClick={() => {
              setReturnFocusLogId(
                journeyOrigin?.nodeId === evidence.nodeId
                  ? journeyOrigin.logId
                  : null
              );
              setJourneyOrigin(null);
              clearInspection();
            }}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ArrowLeft />
          </Button>
          <h2
            className="min-w-0 break-words font-semibold text-sm outline-none"
            ref={headingRef}
            tabIndex={-1}
          >
            {evidence.title}
          </h2>
        </div>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 pl-6 text-muted-foreground text-xs">
          <span>{nodeKindLabel(evidence.nodeType)}</span>
          <span aria-hidden="true">·</span>
          {shownExecution ? (
            <span className={getStatusTextClass(shownExecution.status)}>
              {getStatusLabel(shownExecution.status)}
            </span>
          ) : (
            <span>Not run</span>
          )}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
        <WorkflowRunNodeEvidence
          evidence={evidence}
          isResuming={run.isResuming}
          onChooseExecution={(logId) => chooseExecution(evidence.nodeId, logId)}
          onResume={run.onResume}
        />
      </div>
    </div>
  );
}

/**
 * The Runs surface in the configuration sheet, under the sheet's own header.
 * Canvas Reveal shows the same reads through `RunsBody`.
 */
export function WorkflowRuns({ listActions }: { listActions?: ReactNode }) {
  const runs = useWorkflowRuns();
  const { screen } = runs;

  switch (screen.kind) {
    case "loading-list":
      return <RunsSkeleton />;
    case "opening-newest":
    case "run-loading":
      return <RunsSkeleton detail />;
    case "list-error":
      return (
        <div className="flex h-full min-h-0 flex-col">
          <RunsListHeader actions={listActions} />
          <RunsLoadFailure retry={screen.retry} />
        </div>
      );
    case "run-unavailable":
      return (
        <div className="flex h-full min-h-0 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <Button
              aria-label="Back to runs list"
              onClick={runs.exitRun}
              size="sm"
              type="button"
              variant="ghost"
            >
              Back
            </Button>
            <h2 className="font-semibold text-sm">Run unavailable</h2>
          </header>
          <RunUnavailableMessage retry={screen.retry} />
        </div>
      );
    case "run":
      return (
        <SheetRun
          onBack={runs.exitRun}
          pinnedGraph={screen.pinnedGraph}
          run={screen.run}
        />
      );
  }

  if (screen.executions.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <RunsListHeader actions={listActions} />
        <div className="min-h-0 flex-1 overflow-y-auto p-3 [scrollbar-gutter:stable_both-edges]">
          <RunsListNotices runs={runs}>
            <RunsEmptyState />
          </RunsListNotices>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <RunsListHeader actions={listActions} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 [scrollbar-gutter:stable_both-edges]">
        <div className="py-2">
          <RunsListNotices runs={runs} />
        </div>
        <WorkflowRunsList
          executions={screen.executions}
          focusId={runs.focusRunId}
          onFocusAnswered={runs.clearRowFocus}
          onSelect={runs.selectRun}
        />
      </div>
    </div>
  );
}
