/**
 * The one line along the bottom of the canvas saying what the editor is doing.
 *
 * Two states share one height. While the draft is on screen, the strip shows
 * the publication badge, the Published mode control beside the version that
 * mode governs, the save state and the issue count. With a run pinned to the
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
import { useAtomValue } from "jotai";
import { can } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { ArrowLeft, ChevronDown, Circle, Clock3 } from "lucide-react";
import { Button } from "#src/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import { Separator } from "#src/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#src/components/ui/tooltip";
import { useSetPublishedMode } from "#src/hooks/use-set-published-mode";
import { WorkflowIssuesChip } from "#src/components/workflow/workflow-issues-chip";
import { WorkflowPublicationBadge } from "#src/components/workflow/workflow-publication-badge";
import {
  WorkflowSaveStatus,
  WorkflowUnloadGuard,
} from "#src/components/workflow/workflow-save-status";
import { useWorkflowWorkspaceNavigation } from "#src/hooks/use-workflow-workspace-navigation";
import { toPinnedRunSummary } from "#src/lib/execution-logs";
import { orpcQuery, workflowPublicationQueryOptions } from "#src/lib/rpc-query";
import {
  publishedModeChoice,
  publishedModeWord,
  runGraphRecipientsLabel,
  type WorkflowRunGraphIdentity,
} from "#src/lib/workflow-run-labels";
import { currentWorkflowModeAtom } from "#src/lib/workflow-save-store";
import {
  comparisonSessionAtom,
  isComparisonPendingAtom,
} from "#src/lib/workflow-comparison-store";
import {
  selectedExecutionIdAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
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

/** The two modes, live first, because that is the mode a workflow ends up in. */
const PUBLISHED_MODES = ["live", "test"] as const;

/**
 * The Published mode control, placed next to the badge that names the version.
 *
 * The label is "Live" or "Test" alone, because the badge beside it already
 * reads "Published version 5". Test uses the warning tone and a filled dot;
 * Live uses an outline, so the mode does not rely on color alone.
 *
 * `useSetPublishedMode` performs the change, on one press in either direction.
 * A viewer who does not own the workflow sees the same control with no menu,
 * and a tooltip gives the reason.
 */
function PublishedModeControl({
  publishedVersion,
}: {
  publishedVersion?: number;
}) {
  const workflowMode = useAtomValue(currentWorkflowModeAtom);
  const canUpdate = can(WfGraphOperations.workflowUpdate.id);
  const setPublishedMode = useSetPublishedMode();
  const isTest = workflowMode === "test";
  const label = publishedModeWord(workflowMode);
  const faceClass = cn(
    "h-6 shrink-0 px-1.5 font-medium",
    isTest && "text-warning hover:bg-warning/10 hover:text-warning"
  );
  // The accessible name starts with the visible word and adds the setting it
  // belongs to, as WCAG 2.5.3 requires.
  const faceName = `Published mode: ${label}`;
  const dot = (
    <Circle
      className={cn("size-2.5", isTest && "fill-current")}
      data-icon="inline-start"
    />
  );

  if (!canUpdate) {
    return (
      <TooltipProvider>
        <Tooltip>
          {/* A disabled button carries `disabled:pointer-events-none`, so it is
              never a hover target and never takes focus, and a reason written
              on it alone reaches nobody. The wrapper receives both, and it is
              what the tooltip hangs from. */}
          <TooltipTrigger
            render={<span className="inline-flex shrink-0" tabIndex={0} />}
          >
            <Button
              aria-label={faceName}
              className={faceClass}
              disabled
              size="sm"
              variant="ghost"
            >
              {dot}
              {label}
            </Button>
          </TooltipTrigger>
          {/* The tooltip is the only surface for this sentence. A `title` beside
              it paints the browser's own tooltip on top of this one, and the
              face reads "Live" or "Test" alone, so the sentence names the
              setting the two words belong to. */}
          <TooltipContent>
            You do not have permission to update this workflow.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={faceName}
            className={faceClass}
            size="sm"
            variant="ghost"
          />
        }
      >
        {dot}
        {label}
        <ChevronDown className="size-3 opacity-50" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            Published mode
            {/* Before the first publish the setting describes a version nobody
                can run yet, so the title says when it starts to matter. */}
            {publishedVersion === undefined ? (
              <span className="block font-normal text-muted-foreground text-xs">
                Takes effect on publish
              </span>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(mode) => {
              if (mode === "live" || mode === "test") {
                void setPublishedMode(mode);
              }
            }}
            value={workflowMode}
          >
            {PUBLISHED_MODES.map((mode) => {
              const choice = publishedModeChoice(mode);
              return (
                <DropdownMenuRadioItem
                  // Put the check at the start of the row so the current mode
                  // is read before the word. The primitive pins its indicator
                  // to the right, and this is the only place that moves it.
                  className="pr-2 pl-8 [&>[data-slot=dropdown-menu-radio-item-indicator]]:right-auto [&>[data-slot=dropdown-menu-radio-item-indicator]]:left-2"
                  key={mode}
                  value={mode}
                >
                  <span>
                    {choice.label}
                    <span className="block font-normal text-muted-foreground text-xs">
                      {choice.description}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
            a Published mode of Live is an affirmative claim about whether real
            email and SMS go out; a blank is the only honest thing to say before
            it is known. The payload's arrival is what says a workflow has been
            loaded. */}
        {publication && (
          <>
            <WorkflowPublicationBadge
              hasUnpublishedChanges={publication.hasUnpublishedChanges}
              isPublished={publication.isPublished}
              publishedVersion={publication.publishedVersion}
            />
            <StripDivider />
            <PublishedModeControl
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
          back out of a pinned run lives inside the run panel, which can be
          collapsed or swapped to another tab while the run stays on the canvas
          refusing every edit. */}
      <Button
        className="h-6 shrink-0 text-info hover:bg-info/10 hover:text-info"
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

function ChangesStatus() {
  const session = useAtomValue(comparisonSessionAtom);
  const pending = useAtomValue(isComparisonPendingAtom);
  const { showDraft } = useWorkflowWorkspaceNavigation();
  const baseVersion = session?.payload.baseVersion?.version;

  return (
    <>
      <StatusItems>
        <span className="shrink-0 whitespace-nowrap font-medium">
          {pending && !session ? "Comparing changes" : "Changes"}
        </span>
        {session ? (
          <>
            <StripDivider />
            <span className="shrink-0 whitespace-nowrap">
              {baseVersion ? `Version ${baseVersion}` : "No published version"}
              {" → "}
              proposed version {session.payload.proposedVersion}
            </span>
          </>
        ) : null}
        <StripDivider />
        <span className="shrink-0 whitespace-nowrap">Editing is off</span>
        <StripDivider />
        <WorkflowSaveStatus />
      </StatusItems>
      <Button
        className="h-6 shrink-0 text-info hover:bg-info/10 hover:text-info"
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

export function WorkflowStatusStrip({ workflowId }: { workflowId?: string }) {
  const workspaceView = useAtomValue(workflowWorkspaceViewAtom);
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
      ) : workspaceView === "changes" ? (
        <ChangesStatus />
      ) : (
        <DraftStatus workflowId={workflowId} />
      )}
    </output>
  );
}
