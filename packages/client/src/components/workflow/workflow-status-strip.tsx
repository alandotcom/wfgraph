/**
 * The one line along the bottom of the canvas saying what the editor is doing.
 *
 * Two states, one height. Editing the draft it reports publication, save, and
 * issues; with a run pinned to the canvas it reports the run and offers the
 * way back to the draft. Both render inside the same fixed-height row on
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
import { useAtomValue } from "jotai";
import { ArrowLeft, Clock3 } from "lucide-react";
import { Button } from "#src/components/ui/button";
import { Separator } from "#src/components/ui/separator";
import { WorkflowIssuesChip } from "#src/components/workflow/workflow-issues-chip";
import { WorkflowPublicationBadge } from "#src/components/workflow/workflow-publication-badge";
import {
  WorkflowSaveStatus,
  WorkflowUnloadGuard,
} from "#src/components/workflow/workflow-save-status";
import { useExitRun } from "#src/hooks/use-exit-run";
import { toPinnedRunSummary } from "#src/lib/execution-logs";
import { orpcQuery, workflowPublicationQueryOptions } from "#src/lib/rpc-query";
import { isExecutionOverlayActiveAtom } from "#src/lib/workflow-graph-store";
import { selectedExecutionIdAtom } from "#src/lib/workflow-ui-store";
import { cn } from "@wfgraph/shared/utils";
import { formatDayAndTime } from "@wfgraph/shared/utils/time";

/**
 * How many characters of a run's id identify it on screen.
 *
 * A run id is a 21-character nanoid, which no strip has room for. Eight
 * characters of base-36 is a fixed width in a line that must not reflow and
 * plenty to tell two runs of one workflow apart; the whole id is on the
 * element's title for anyone who needs to quote it.
 */
const RUN_ID_PREFIX_LENGTH = 8;

/**
 * Which run is on the canvas and when it started, as one string.
 *
 * Empty while the run's payload is still in flight, and empty again if the
 * payload carried a timestamp that will not parse: `startedAt` crosses the wire
 * as a plain string, and a strip reading "NaN undefined, NaN:NaN" is worse than
 * one that names no time at all.
 */
export function pinnedRunLabel(
  run: { id: string; startedAt: Date | null } | undefined
): string {
  if (!run) {
    return "";
  }
  if (!run.startedAt) {
    return run.id.slice(0, RUN_ID_PREFIX_LENGTH);
  }
  return `${run.id.slice(0, RUN_ID_PREFIX_LENGTH)} · ${formatDayAndTime(run.startedAt)}`;
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

function DraftStatus({ workflowId }: { workflowId?: string }) {
  const { data: publication } = useQuery({
    ...workflowPublicationQueryOptions(workflowId ?? ""),
    enabled: Boolean(workflowId),
  });

  return (
    <>
      <StatusItems>
        {/* Both of these wait on the payload rather than on `workflowId`. The
            mode atom answers "live" until a workflow is hydrated into it, and
            "Live mode" is an affirmative claim about whether real email and SMS
            go out; a blank is the only honest thing to say before it is known.
            The payload's arrival is what says a workflow has been loaded. */}
        {publication && (
          <>
            <WorkflowPublicationBadge
              hasUnpublishedChanges={publication.hasUnpublishedChanges}
              isPublished={publication.isPublished}
              publishedVersion={publication.publishedVersion}
            />
            <StripDivider />
          </>
        )}
        {/* Not gated on the payload, unlike the badges above: a canvas nobody
            has saved yet has the most to lose. It is owner-gated for itself. */}
        <WorkflowSaveStatus />
      </StatusItems>
      <WorkflowIssuesChip />
    </>
  );
}

function PinnedRunStatus() {
  const executionId = useAtomValue(selectedExecutionIdAtom);
  const exitRun = useExitRun();

  // Reads the logs entry `ExecutionOverlaySync` fills to pin the graph in the
  // first place, so a run that is on the canvas has already been fetched:
  // `staleTime: Infinity` means this observer asks for nothing of its own.
  const { data: run } = useQuery({
    ...orpcQuery.workflow.getExecutionLogs.queryOptions({
      input: { executionId: executionId ?? "" },
      select: toPinnedRunSummary,
    }),
    enabled: executionId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const label = pinnedRunLabel(run);

  return (
    <>
      <StatusItems>
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium">
          <Clock3 aria-hidden className="size-3" />
          Viewing a past run
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
          back out of a pinned run lives inside the run panel, which can be
          collapsed or swapped to another tab while the run stays on the canvas
          refusing every edit. */}
      <Button
        className="h-6 shrink-0 text-info hover:bg-info/10 hover:text-info"
        onClick={exitRun}
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

export function WorkflowStatusStrip({ workflowId }: { workflowId?: string }) {
  const overlayActive = useAtomValue(isExecutionOverlayActiveAtom);

  return (
    <output
      aria-live="polite"
      className={cn(
        // `h-8` is the contract with React Flow. Panel tone rather than card:
        // `--card` and `--background` are the same white in light mode, so a
        // card-toned strip on a background-toned canvas separated by nothing but
        // its border.
        "workflow-status-strip flex h-8 shrink-0 items-center gap-2 border-t px-3 text-xs leading-none",
        overlayActive
          ? "border-info/30 bg-info/5 text-info"
          : "bg-sidebar text-muted-foreground"
      )}
    >
      {/* Outside the branch below, because a reload drops a pending patch
          whether or not the label reporting it is the one on screen. */}
      <WorkflowUnloadGuard />
      {overlayActive ? (
        <PinnedRunStatus />
      ) : (
        <DraftStatus workflowId={workflowId} />
      )}
    </output>
  );
}
