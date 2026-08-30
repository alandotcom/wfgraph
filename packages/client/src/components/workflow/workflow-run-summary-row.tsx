import { ArrowLeft, Ban, Loader2 } from "lucide-react";
import { useRef } from "react";
import { Button } from "#src/components/ui/button";
import { useAfterCommit } from "#src/hooks/effects";
import { cn } from "@wfgraph/shared/utils";
import { getRelativeTime } from "@wfgraph/shared/utils/time";
import {
  type ExecutionLog,
  type WorkflowExecution,
} from "#src/lib/execution-logs";
import {
  runGraphLabel,
  runGraphRecipientsLabel,
  runRecipientsLabel,
} from "#src/lib/workflow-run-labels";
import {
  formatDuration,
  getStatusDotClass,
  getStatusLabel,
  getStatusTextClass,
} from "./workflow-run-shared";

type WorkflowRunSummaryRowProps = {
  execution: WorkflowExecution;
  runNumber: number;
  variant?: "list" | "header";
  outcome?: string;
  onClick?: () => void;
  selected?: boolean;
  onBack?: () => void;
  onCancel?: (executionId: string) => void;
  isCanceling?: boolean;
  focusOnMount?: boolean;
};

export function getRunIdentity(
  execution: WorkflowExecution,
  runNumber: number
): { title: string; context: string | null } {
  const eventName = execution.startEventName?.trim();
  const entity = execution.entityValue?.trim();

  if (eventName) {
    return { title: eventName, context: entity || null };
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
  if (execution.startSource === "schedule") {
    return { title: "Scheduled run", context: null };
  }
  if (execution.startSource === "manual") {
    return { title: "Manual run", context: null };
  }
  return { title: `Run #${runNumber}`, context: null };
}

function relevantLog(logs: ExecutionLog[], status: ExecutionLog["status"]) {
  return logs.findLast((log) => log.status === status);
}

export function getRunOutcome(
  execution: WorkflowExecution,
  logs: ExecutionLog[]
): string {
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
    case "superseded":
      return "Replaced by a newer start";
  }
  return "Run status unavailable";
}

function ListSummary({
  execution,
  runNumber,
}: {
  execution: WorkflowExecution;
  runNumber: number;
}) {
  const identity = getRunIdentity(execution, runNumber);

  return (
    <div className="grid min-w-0 grid-cols-[0.75rem_minmax(0,1fr)] gap-2">
      <div className="flex justify-center pt-1.5">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            execution.status === "running" &&
              "ring-2 ring-info/20 motion-safe:animate-pulse",
            getStatusDotClass(execution.status)
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
          <span className={getStatusTextClass(execution.status)}>
            {getStatusLabel(execution.status)}
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
  onBack,
  onCancel,
  isCanceling = false,
  focusOnMount = false,
}: {
  execution: WorkflowExecution;
  runNumber: number;
  outcome?: string;
  onBack?: () => void;
  onCancel?: (executionId: string) => void;
  isCanceling?: boolean;
  focusOnMount?: boolean;
}) {
  const identity = getRunIdentity(execution, runNumber);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useAfterCommit(focusOnMount, () => {
    if (focusOnMount) {
      headingRef.current?.focus();
    }
  });

  return (
    <div className="min-w-0 border-b bg-background px-3 py-3">
      <div className="flex min-w-0 items-start gap-1">
        {onBack ? (
          <Button
            aria-label="Back to runs list"
            className="-ml-1 max-md:size-11"
            onClick={onBack}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ArrowLeft />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1 pt-0.5">
          <h2
            className="break-words font-semibold text-sm outline-none"
            ref={headingRef}
            tabIndex={-1}
          >
            {identity.title}
          </h2>
          <p
            aria-live="polite"
            className={cn("mt-1 text-xs", getStatusTextClass(execution.status))}
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
        <MetadataRow
          label="Started"
          value={execution.startedAt.toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
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
  selected = false,
  onBack,
  onCancel,
  isCanceling = false,
  focusOnMount = false,
}: WorkflowRunSummaryRowProps) {
  if (variant === "header") {
    return (
      <div data-testid="workflow-run-summary-row">
        <HeaderSummary
          execution={execution}
          isCanceling={isCanceling}
          focusOnMount={focusOnMount}
          onBack={onBack}
          onCancel={onCancel}
          outcome={outcome}
          runNumber={runNumber}
        />
      </div>
    );
  }

  return (
    <button
      aria-current={selected ? "true" : undefined}
      className={cn(
        "min-h-13 w-full border-border border-b px-2 py-2 text-left transition-colors duration-100 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30",
        selected && "bg-muted"
      )}
      data-testid="workflow-run-summary-row"
      onClick={onClick}
      type="button"
    >
      <ListSummary execution={execution} runNumber={runNumber} />
    </button>
  );
}
