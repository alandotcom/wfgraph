/**
 * The one line along the bottom of the canvas saying what the editor is doing.
 *
 * Two states share one height. While the draft is on screen, the strip shows
 * the save state and the issue count; the publication state is the chip beside
 * the workflow's name. With a run pinned to the
 * canvas it shows the run and a way back to the draft. Both render inside the same fixed-height row on
 * purpose: the strip is a `shrink-0` sibling of the canvas box, so any change in
 * its height comes straight out of React Flow's, which measures what it is given
 * and reacts to every pixel of it. Nothing in here may wrap, and nothing may
 * grow with a count. The one height that is not `h-8` is set in `globals.css`,
 * where a phone's bottom safe-area inset is added to both the height and the
 * padding; that is constant per device and never changes under the user.
 *
 * The whole row is one polite live region. Everything it holds is a status, the
 * save label changes while the user is looking elsewhere, and an issue count
 * arriving from nothing has to be announced, so a single region reads each
 * change once instead of several nested ones queueing the same sentence.
 */

import { useQuery } from "@tanstack/react-query";
import { useAtomValue, useAtomValueRawSync } from "jotai";
import { can } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { ArrowLeft, Clock3, RefreshCw } from "lucide-react";
import { Button } from "#src/components/ui/button";
import { Separator } from "#src/components/ui/separator";
import { WorkflowIssuesChip } from "#src/components/workflow/workflow-issues-chip";
import {
  WorkflowSaveStatus,
  WorkflowUnloadGuard,
} from "#src/components/workflow/workflow-save-status";
import { useWorkflowWorkspaceNavigation } from "#src/hooks/use-workflow-workspace-navigation";
import { toPinnedRunSummary } from "#src/lib/execution-logs";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  runGraphRecipientsLabel,
  runShortId,
  type WorkflowRunGraphIdentity,
} from "#src/lib/workflow-run-labels";
import { draftSaveRefusedAtom } from "#src/lib/workflow-save-store";
import { remoteDraftChangeAtom } from "#src/lib/workflow-graph-store";
import {
  selectedExecutionIdAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import { cn } from "@wfgraph/shared/utils";
import { formatExactTime } from "@wfgraph/shared/utils/time";

/**
 * Which run is on the canvas and when it started, as one string.
 *
 * Empty while the run's payload is still in flight, and empty again if the
 * payload carried a timestamp that will not parse: `startedAt` crosses the wire
 * as a plain string, and a strip reading "Invalid Date" is worse than one that
 * names no time at all.
 */
export function pinnedRunLabel(
  run: { id: string; startedAt: Date | null } | undefined
): string {
  if (!run) {
    return "";
  }
  if (!run.startedAt) {
    return runShortId(run.id);
  }
  return `${runShortId(run.id)} · ${formatExactTime(run.startedAt)}`;
}

/**
 * Names the pinned run by the graph it ran and the recipients it reached, as
 * "Draft · Test run" or "v7 · Live run".
 *
 * The phrase comes from `workflow-run-labels`, so the strip, the run history
 * table and the summary row stay in step. Returns empty while the run's payload
 * is loading, and empty for a published run with no version number, which the
 * contract rejects. The strip then falls back to "Viewing a past run".
 */
export function pinnedRunModeLabel(
  run: WorkflowRunGraphIdentity | undefined
): string {
  if (!run) {
    return "";
  }
  if (run.versionKind === "published" && run.versionNumber === null) {
    return "";
  }
  return `${runGraphRecipientsLabel(run)} run`;
}

/**
 * A hairline between two of the strip's items.
 *
 * The height override carries the `data-vertical:` prefix the base style uses
 * for `self-stretch`, so tailwind-merge drops that one rather than keeping both:
 * a stretched box with a definite height resolves to flex-start and the rule
 * hung from the top of the row.
 */
function StripDivider() {
  return (
    <Separator
      className="data-vertical:h-3 data-vertical:self-center bg-current opacity-20"
      orientation="vertical"
    />
  );
}

/** The left-hand run of items, which scrolls rather than clipping what it cannot fit. */
function StatusItems({ children }: { children: React.ReactNode }) {
  return (
    // `overflow-x-auto` rather than `overflow-hidden`: the save label sits last
    // and would otherwise be the first thing a narrowing column made
    // unreachable, which is exactly the item that changes on its own. The
    // scrollbar is hidden because this row's height is fixed and a classic
    // scrollbar would eat half of it.
    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {children}
    </div>
  );
}

function DraftStatus({ workflowId }: { workflowId?: string | undefined }) {
  const remoteDraftChange = useAtomValue(remoteDraftChangeAtom);
  // A newer draft is learned of two ways: the draft stream observes it beside
  // unsaved edits, or the server refuses this editor's save because of it.
  const draftSaveRefused = useAtomValue(draftSaveRefusedAtom);
  const hasRemoteDraftChange =
    remoteDraftChange?.workflowId === workflowId || draftSaveRefused;

  return (
    <>
      <StatusItems>
        {/* The publication state is the chip beside the workflow's name, so
            in Draft the strip says whether the draft is saved. A canvas nobody
            has saved yet has the most to lose. It is owner-gated for itself. */}
        <WorkflowSaveStatus />
        {hasRemoteDraftChange ? (
          <>
            <StripDivider />
            <span className="shrink-0 whitespace-nowrap text-warning">
              Draft changed elsewhere
            </span>
            <Button
              className="h-6 shrink-0 text-warning hover:text-warning"
              onClick={() => window.location.reload()}
              size="sm"
              type="button"
              variant="ghost"
            >
              <RefreshCw className="size-3" />
              Reload agent edits
            </Button>
          </>
        ) : null}
      </StatusItems>
      <WorkflowIssuesChip />
    </>
  );
}

function PinnedRunStatus() {
  // Route synchronization can select the run before subscriptions mount.
  const executionId = useAtomValueRawSync(selectedExecutionIdAtom);
  const { showDraft } = useWorkflowWorkspaceNavigation();
  const canReadLogs = can(WfGraphOperations.workflowGetExecutionLogs.id);

  // Reads the logs entry `ExecutionOverlaySync` fills to pin the graph in the
  // first place, so a run that is on the canvas has already been fetched:
  // `staleTime: Infinity` means this observer asks for nothing of its own.
  const { data: run } = useQuery({
    ...orpcQuery.workflow.getExecutionLogs.queryOptions({
      input: { executionId: executionId ?? "" },
      select: toPinnedRunSummary,
    }),
    enabled: executionId !== null && canReadLogs,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const label = pinnedRunLabel(run);
  const modeLabel = pinnedRunModeLabel(run);

  return (
    <>
      <StatusItems>
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium">
          <Clock3 aria-hidden className="size-3" />
          {executionId ? modeLabel || "Viewing a past run" : "Runs"}
        </span>
        {label && (
          <>
            <StripDivider />
            <span
              className="shrink-0 whitespace-nowrap font-mono tabular-nums"
              title={run?.id}
            >
              {label}
            </span>
          </>
        )}
        <StripDivider />
        {/* The overlay, not `canvasEditingLockedAtom`: that atom is also raised
            while the AI is rewriting the graph, and this sentence is about the
            pinned run standing between the builder and the draft. */}
        <span className="shrink-0 whitespace-nowrap">Editing is off</span>
        {/* Reported here too, because a save that failed just before the run was
            opened is still unsaved work and the draft is what it belongs to. */}
        <StripDivider />
        <WorkflowSaveStatus />
      </StatusItems>
      {/* The one control on the strip, and the answer to #96: every other way
          back out of a pinned run lives inside the Inspector or the outline,
          which can be closed or hidden while the run stays on the canvas
          refusing every edit. */}
      <Button
        className="h-6 shrink-0 text-info hover:text-info"
        onClick={showDraft}
        size="sm"
        type="button"
        variant="ghost"
      >
        <ArrowLeft className="size-3" />
        Back to draft
      </Button>
    </>
  );
}

export function WorkflowStatusStrip({
  workflowId,
}: {
  workflowId?: string | undefined;
}) {
  // Route synchronization can switch the workspace before subscriptions mount.
  const workspaceView = useAtomValueRawSync(workflowWorkspaceViewAtom);
  const readOnly = workspaceView !== "draft";

  return (
    <output
      aria-live="polite"
      className={cn(
        // `h-8` is the contract with React Flow. Panel tone rather than card:
        // `--card` and `--background` are the same white in light mode, so a
        // card-toned strip on a background-toned canvas separated by nothing but
        // its border.
        "workflow-status-strip flex h-8 shrink-0 items-center gap-2 border-t px-3 text-xs leading-none",
        readOnly
          ? "border-info/30 bg-info/5 text-info"
          : "bg-sidebar text-muted-foreground"
      )}
    >
      {/* Outside the branch below, because a reload drops a pending patch
          whether or not the label reporting it is the one on screen. */}
      <WorkflowUnloadGuard />
      {workspaceView === "runs" ? (
        <PinnedRunStatus />
      ) : (
        <DraftStatus workflowId={workflowId} />
      )}
    </output>
  );
}
