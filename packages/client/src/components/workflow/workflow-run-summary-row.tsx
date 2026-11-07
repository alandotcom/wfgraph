import { Ban, Loader2 } from "lucide-react";
import { useRef } from "react";
import { Button } from "#src/components/ui/button";
import { useAfterCommit } from "#src/hooks/effects";
import { cn } from "@wfgraph/shared/utils";
import { getRelativeTime } from "@wfgraph/shared/utils/time";
import {
  type ExecutionLog,
  isRunInProgress,
  type WorkflowExecution,
} from "#src/lib/execution-logs";
import {
  runGraphLabel,
  runGraphRecipientsLabel,
  runRecipientsLabel,
} from "#src/lib/workflow-run-labels";
import {
  formatDuration,
  runStatusLabel,
  runStatusTone,
  statusToneDotClass,
  statusToneTextClass,
} from "./workflow-run-shared";
import { useListActivityLabel } from "./use-list-activity-label";

type WorkflowRunSummaryRowProps = {
  execution: WorkflowExecution;
  runNumber: number;
  variant?: "list" | "header" | undefined;
  outcome?: string | undefined;
  onClick?: (() => void) | undefined;
  onCancel?: ((executionId: string) => void) | undefined;
  isCanceling?: boolean | undefined;
  focusOnMount?: boolean | undefined;
  /**
   * The browser's clock when a list row's page arrived, which the row's
   * `activity` measures an unclaimed run's wait from, or null while the list
   * shows rows it kept from an earlier answer.
   */
  receivedAtMs?: number | null | undefined;
};

/**
 * The run's title and the line beneath it. A scheduled run carries no payload
 * and its Entity Value is the workflow's own (`workflow:<id>`), so it is
 * titled by its source alone.
 */
export function getRunIdentity(
  execution: WorkflowExecution,
  runNumber: number
): { title: string; context: string | null } {
  const eventName = execution.startEventName?.trim();
  const entity = execution.entityValue?.trim();

  if (eventName) {
    return { title: eventName, context: entity || null };
  }
  if (execution.startSource === "schedule") {
    return { title: "Scheduled run", context: null };
  }
  if (
    execution.startSource === "manual" &&
    entity === `workflow:${execution.workflowId}`
  ) {
    return { title: "Manual run", context: null };
  }
  if (entity) {
    return { title: entity, context: null };
  }
  if (execution.startSource === "manual") {
    return { title: "Manual run", context: null };
  }
  return { title: `Run #${runNumber}`, context: null };
}

function relevantLog(logs: ExecutionLog[], status: ExecutionLog["status"]) {
  return logs.findLast((log) => log.status === status);
}

/**
 * The latest log of a node among `retryingNodeIds`, the nodes with a step the
 * executor will run again, or undefined for none.
 */
export function retryingLog(
  logs: ExecutionLog[],
  retryingNodeIds: readonly string[]
): ExecutionLog | undefined {
  return logs.findLast((log) => retryingNodeIds.includes(log.nodeId));
}

/**
 * A run's outcome in a few words. While the run is in progress and a node
 * among `retryingNodeIds` has a log, it reads "Retrying" that node, as the
 * canvas chip does.
 */
export function getRunOutcome(
  execution: WorkflowExecution,
  logs: ExecutionLog[],
  retryingNodeIds: readonly string[] = []
): string {
  const retrying = isRunInProgress(execution.status)
    ? retryingLog(logs, retryingNodeIds)
    : undefined;
  if (retrying !== undefined) {
    return `Retrying ${retrying.nodeName || retrying.nodeType}`;
  }
  switch (execution.status) {
    case "completed":
      return execution.duration
        ? `Completed in ${formatDuration(execution.duration)}`
        : "Completed";
    case "failed": {
      const failed = relevantLog(logs, "error");
      return failed
        ? `Failed at ${failed.nodeName || failed.nodeType}`
        : "Failed";
    }
    case "running": {
      const active = relevantLog(logs, "running");
      return active
        ? `Running ${active.nodeName || active.nodeType}`
        : "Run in progress";
    }
    case "waiting": {
      const waiting = relevantLog(logs, "running") ?? logs.at(-1);
      return waiting
        ? `Waiting at ${waiting.nodeName || waiting.nodeType}`
        : "Waiting to resume";
    }
    case "pending":
      return "Preparing to run";
    case "canceled": {
      const completedSteps = logs.filter(
        (log) => log.status === "success"
      ).length;
      return `Canceled after ${completedSteps} ${completedSteps === 1 ? "step" : "steps"}`;
    }
    case "exited":
      return "Exited by Entity eligibility";
    case "superseded":
      return "Replaced by a newer start";
  }
  return "Run status unavailable";
}

function ListSummary({
  execution,
  runNumber,
  receivedAtMs,
}: {
  execution: WorkflowExecution;
  runNumber: number;
  receivedAtMs: number | null;
}) {
  const identity = getRunIdentity(execution, runNumber);
  // What the executor is doing about the run, said in place of the status word.
  const activityLabel = useListActivityLabel(execution.activity, receivedAtMs);

  return (
    <div className="grid min-w-0 grid-cols-[0.75rem_minmax(0,1fr)] gap-2">
      <div className="flex justify-center pt-1.5">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            execution.status === "running" &&
              "ring-2 ring-info/20 motion-safe:animate-pulse",
            statusToneDotClass(runStatusTone(execution.status))
          )}
        />
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium text-sm">{identity.title}</span>
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            {getRelativeTime(execution.startedAt)}
          </span>
        </div>
        {identity.context ? (
          <p className="truncate text-muted-foreground text-xs">
            {identity.context}
          </p>
        ) : null}
        <p className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-muted-foreground text-xs">
          <span>Run #{runNumber}</span>
          <span aria-hidden="true">·</span>
          <span
            className={statusToneTextClass(
              activityLabel?.warns === true
                ? "warning"
                : runStatusTone(execution.status)
            )}
          >
            {activityLabel?.text ?? runStatusLabel(execution.status)}
          </span>
          <span aria-hidden="true">·</span>
          <span>{runGraphRecipientsLabel(execution)}</span>
          {execution.duration ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {formatDuration(execution.duration)}
              </span>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}

/**
 * How far a scheduled run's start may trail its slot before the overview shows
 * the slot as a fact of its own. A worker claims a due timer within moments,
 * so a gap past this means the run started late.
 */
const LATE_START_MS = 60_000;

/**
 * The slot a scheduled run fired for, when the run started more than
 * `LATE_START_MS` after it, and null otherwise.
 */
function lateScheduledSlot(execution: WorkflowExecution): Date | null {
  const { scheduledFor, startedAt } = execution;
  if (scheduledFor === null) {
    return null;
  }
  return Math.abs(startedAt.getTime() - scheduledFor.getTime()) > LATE_START_MS
    ? scheduledFor
    : null;
}

/** A date and time in the reader's locale, as the overview prints each one. */
function formatOverviewTime(value: Date): string {
  return value.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{value}</dd>
    </div>
  );
}

function HeaderSummary({
  execution,
  runNumber,
  outcome,
  onCancel,
  isCanceling = false,
  focusOnMount = false,
}: {
  execution: WorkflowExecution;
  runNumber: number;
  outcome?: string | undefined;
  onCancel?: ((executionId: string) => void) | undefined;
  isCanceling?: boolean | undefined;
  focusOnMount?: boolean | undefined;
}) {
  const identity = getRunIdentity(execution, runNumber);
  const lateSlot = lateScheduledSlot(execution);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useAfterCommit(focusOnMount, () => {
    if (focusOnMount) {
      headingRef.current?.focus();
    }
  });

  return (
    <div className="min-w-0 border-b bg-background px-3 py-3">
      <div className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1 pt-0.5">
          <h2
            className="break-words font-semibold text-base outline-none"
            ref={headingRef}
            tabIndex={-1}
          >
            {identity.title}
          </h2>
          <p
            aria-live="polite"
            className={cn(
              "mt-1 text-sm",
              statusToneTextClass(runStatusTone(execution.status))
            )}
            role="status"
          >
            {outcome ?? getRunOutcome(execution, [])}
          </p>
        </div>
        {onCancel ? (
          <Button
            aria-label="Cancel"
            disabled={isCanceling}
            onClick={() => onCancel(execution.id)}
            className="max-md:h-11"
            size="sm"
            type="button"
            variant="ghost"
          >
            {isCanceling ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" />
            ) : (
              <Ban />
            )}
            Cancel
          </Button>
        ) : null}
      </div>

      <dl className="mt-3 space-y-1.5 pl-6">
        {identity.context ? (
          <MetadataRow label="Entity" value={identity.context} />
        ) : null}
        {lateSlot ? (
          <MetadataRow label="Scheduled" value={formatOverviewTime(lateSlot)} />
        ) : null}
        <MetadataRow
          label="Started"
          value={formatOverviewTime(execution.startedAt)}
        />
        <MetadataRow
          label="Graph"
          value={runGraphLabel(execution, "qualified")}
        />
        <MetadataRow
          label="Recipients"
          value={runRecipientsLabel(execution.runMode)}
        />
        <MetadataRow
          label="Run"
          value={runNumber > 0 ? `#${runNumber}` : execution.id}
        />
        {execution.startSource ? (
          <MetadataRow
            label="Source"
            value={
              execution.startSource[0].toUpperCase() +
              execution.startSource.slice(1)
            }
          />
        ) : null}
      </dl>
    </div>
  );
}

export function WorkflowRunSummaryRow({
  execution,
  runNumber,
  variant = "list",
  outcome,
  onClick,
  onCancel,
  isCanceling = false,
  focusOnMount = false,
  receivedAtMs = null,
}: WorkflowRunSummaryRowProps) {
  if (variant === "header") {
    return (
      <div data-testid="workflow-run-summary-row">
        <HeaderSummary
          execution={execution}
          isCanceling={isCanceling}
          focusOnMount={focusOnMount}
          onCancel={onCancel}
          outcome={outcome}
          runNumber={runNumber}
        />
      </div>
    );
  }

  return (
    <button
      className="min-h-13 w-full border-border border-b px-2 py-2 text-left transition-colors duration-100 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"
      data-testid="workflow-run-summary-row"
      onClick={onClick}
      type="button"
    >
      <ListSummary
        execution={execution}
        receivedAtMs={receivedAtMs}
        runNumber={runNumber}
      />
    </button>
  );
}
