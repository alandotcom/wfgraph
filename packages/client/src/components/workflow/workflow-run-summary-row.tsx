import { Ban, Loader2 } from "lucide-react";
import { useRef } from "react";
import { Button } from "#src/components/ui/button";
import { useAfterCommit } from "#src/hooks/effects";
import { cn } from "@wfgraph/shared/utils";
import { formatExactTime } from "@wfgraph/shared/utils/time";
import {
  type ExtensionCatalog,
  findEntity,
  findEvent,
} from "@wfgraph/shared/extensions/catalog";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { workflowEntityValue } from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  type ExecutionLog,
  isRunInProgress,
  type WorkflowExecution,
} from "#src/lib/execution-logs";
import {
  runGraphRecipientsLabel,
  runShortId,
} from "#src/lib/workflow-run-labels";
import {
  formatDuration,
  listDuration,
  listStatusTextClass,
  runStatusLabel,
  runStatusTone,
  statusToneDotClass,
  statusToneTextClass,
} from "./workflow-run-shared";
import { useListActivityLabel } from "./use-list-activity-label";

type WorkflowRunSummaryRowProps = {
  execution: WorkflowExecution;
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
 * How a run is named. `title` is the run's Entity, such as "Patient
 * pat_20418", or how the run started when it has no Entity. `startedBy` is
 * the line beneath the title, which names the Event or the schedule that
 * started the run, and is null when the title already says it. `event` is the
 * starting Event's machine name and catalog label, and `schedule` the starting
 * schedule in words; each is null for a run something else started.
 */
type RunIdentity = {
  title: string;
  startedBy: string | null;
  event: { name: string; label: string } | null;
  schedule: string | null;
};

/** The fields of a run its identity is read from. */
type RunIdentitySource = Pick<
  WorkflowExecution,
  | "id"
  | "startEventName"
  | "entityValue"
  | "entity"
  | "startSource"
  | "scheduleDescription"
  | "workflowId"
>;

/**
 * The run's name and the line beneath it, which every run list, the run
 * summary and `runTitle` read. A run of a workflow that tracks an Entity is
 * named by the Entity's label in `catalog` and its id. A run of a workflow
 * that tracks none is named by its Entity Value, the payload value its
 * Correlation Path selected. A run with neither is named by the label of the
 * Event that started it, or as a scheduled, manual or plain run. The Entity
 * Value of a run started with no payload is the workflow's own
 * (`workflow:<id>`), which names no Entity and so is never a title.
 */
export function getRunIdentity(
  execution: RunIdentitySource,
  catalog: ExtensionCatalog
): RunIdentity {
  const eventName = execution.startEventName?.trim();
  const event = eventName
    ? {
        name: eventName,
        label: findEvent(catalog, eventName)?.label ?? eventName,
      }
    : null;
  const schedule =
    execution.startSource === "schedule" ? execution.scheduleDescription : null;
  const entity = runEntityName(execution, catalog);

  if (entity !== null) {
    return {
      title: entity,
      startedBy: event?.label ?? schedule,
      event,
      schedule,
    };
  }
  if (event !== null) {
    return { title: event.label, startedBy: null, event, schedule };
  }
  return {
    title: unnamedRunTitle(execution),
    startedBy: schedule,
    event,
    schedule,
  };
}

/**
 * The name a run goes by where it is the one object shown: its title and the
 * minute it started, such as "Patient pat_20418 · Nov 25, 7:42 AM". The Runs
 * header, its path and the phone's Back label use it, so a person can name a
 * run to someone else without quoting a run id.
 */
export function runTitle(
  execution: RunIdentitySource & Pick<WorkflowExecution, "startedAt">,
  catalog: ExtensionCatalog
): string {
  return `${getRunIdentity(execution, catalog).title} · ${formatExactTime(execution.startedAt)}`;
}

/**
 * The run's Entity in words, or null for a run that names none. A tracked
 * Entity whose type the catalog no longer declares is named by its type.
 */
function runEntityName(
  execution: RunIdentitySource,
  catalog: ExtensionCatalog
): string | null {
  if (execution.entity) {
    const { type, id } = execution.entity;
    return `${findEntity(catalog, type)?.label ?? type} ${id}`;
  }
  const value = execution.entityValue?.trim();
  return value && value !== workflowEntityValue(execution.workflowId)
    ? value
    : null;
}

/** The title of a run with no Entity that no Event started. */
function unnamedRunTitle(execution: RunIdentitySource): string {
  switch (execution.startSource) {
    case "schedule":
      return "Scheduled run";
    case "manual":
      return "Manual run";
    default:
      return "Run";
  }
}

/**
 * The header's Event row: the Event's label beside its machine name, or the
 * machine name alone when the run's title already is the label. Null when the
 * row would only repeat the title.
 */
function eventDetail(identity: RunIdentity): string | null {
  const { event, title } = identity;
  if (event === null || event.name === title) {
    return null;
  }
  return event.label === event.name || event.label === title
    ? event.name
    : `${event.label} (${event.name})`;
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
  receivedAtMs,
}: {
  execution: WorkflowExecution;
  receivedAtMs: number | null;
}) {
  const identity = getRunIdentity(execution, useExtensionCatalog());
  const duration = listDuration(execution.duration);
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
        <p className="truncate font-medium text-sm">{identity.title}</p>
        {/* What started the run and when, the time in the format the run's
            header names it by. */}
        <p className="flex min-w-0 items-baseline gap-x-1.5 text-muted-foreground text-xs">
          {identity.startedBy === null ? null : (
            <>
              <span className="truncate">{identity.startedBy}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="shrink-0 tabular-nums">
            {formatExactTime(execution.startedAt)}
          </span>
        </p>
        <p className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-muted-foreground text-xs">
          <span
            className={listStatusTextClass(
              activityLabel?.warns === true
                ? "warning"
                : runStatusTone(execution.status)
            )}
          >
            {activityLabel?.text ?? runStatusLabel(execution.status)}
          </span>
          <span aria-hidden="true">·</span>
          <span>{runGraphRecipientsLabel(execution)}</span>
          {duration === null ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{duration}</span>
            </>
          )}
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
  outcome,
  onCancel,
  isCanceling = false,
  focusOnMount = false,
}: {
  execution: WorkflowExecution;
  outcome?: string | undefined;
  onCancel?: ((executionId: string) => void) | undefined;
  isCanceling?: boolean | undefined;
  focusOnMount?: boolean | undefined;
}) {
  const identity = getRunIdentity(execution, useExtensionCatalog());
  const eventLine = eventDetail(identity);
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
        {eventLine === null ? null : (
          <MetadataRow label="Event" value={eventLine} />
        )}
        {identity.schedule === null ? null : (
          <MetadataRow label="Schedule" value={identity.schedule} />
        )}
        {lateSlot ? (
          <MetadataRow label="Scheduled" value={formatExactTime(lateSlot)} />
        ) : null}
        <MetadataRow
          label="Started"
          value={formatExactTime(execution.startedAt)}
        />
        <MetadataRow
          label="Version"
          value={runGraphRecipientsLabel(execution)}
        />
        <MetadataRow label="Run" value={runShortId(execution.id)} />
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
      <ListSummary execution={execution} receivedAtMs={receivedAtMs} />
    </button>
  );
}
