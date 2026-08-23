import { ArrowLeft, Ban, Loader2 } from "lucide-react";
import { Button } from "#src/components/ui/button";
import { cn } from "@wfgraph/shared/utils";
import { getRelativeTime } from "@wfgraph/shared/utils/time";
import { type WorkflowExecution } from "#src/lib/execution-logs";
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
  onClick?: () => void;
  selected?: boolean;
  onBack?: () => void;
  onCancel?: (executionId: string) => void;
  isCanceling?: boolean;
};

function StatusLine({ execution }: { execution: WorkflowExecution }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
      <span className={getStatusTextClass(execution.status)}>
        {getStatusLabel(execution.status)}
      </span>
      {execution.runMode === "test" ? (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">Test</span>
        </>
      ) : null}
    </p>
  );
}

function ListSummary({
  execution,
  runNumber,
}: {
  execution: WorkflowExecution;
  runNumber: number;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          getStatusDotClass(execution.status)
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium text-sm">Run #{runNumber}</span>
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            {getRelativeTime(execution.startedAt)}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <StatusLine execution={execution} />
          {execution.duration ? (
            <span className="font-mono text-muted-foreground text-xs tabular-nums">
              {formatDuration(execution.duration)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function HeaderSummary({
  execution,
  runNumber,
  onBack,
  onCancel,
  isCanceling = false,
}: {
  execution: WorkflowExecution;
  runNumber: number;
  onBack?: () => void;
  onCancel?: (executionId: string) => void;
  isCanceling?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1">
        {onBack ? (
          <Button
            aria-label="Back to runs list"
            onClick={onBack}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ArrowLeft />
          </Button>
        ) : null}
        <h2 className="min-w-0 font-medium text-sm">Run #{runNumber}</h2>
      </div>
      <StatusLine execution={execution} />
      <p className="text-muted-foreground text-xs">
        {getRelativeTime(execution.startedAt)}
      </p>
      {execution.startSource ? (
        <p className="text-muted-foreground text-xs capitalize">
          {execution.startSource}
        </p>
      ) : null}
      {execution.startEventName ? (
        <p className="break-words text-muted-foreground text-xs">
          {execution.startEventName}
        </p>
      ) : null}
      {execution.duration ? (
        <p className="font-mono text-muted-foreground text-xs tabular-nums">
          {formatDuration(execution.duration)}
        </p>
      ) : null}
      {onCancel ? (
        <Button
          className="mt-1 w-full"
          disabled={isCanceling}
          onClick={() => onCancel(execution.id)}
          size="sm"
          type="button"
          variant="outline"
        >
          {isCanceling ? (
            <Loader2 className="mr-1 size-3 animate-spin" />
          ) : (
            <Ban className="mr-1 size-3" />
          )}
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

export function WorkflowRunSummaryRow({
  execution,
  runNumber,
  variant = "list",
  onClick,
  selected = false,
  onBack,
  onCancel,
  isCanceling = false,
}: WorkflowRunSummaryRowProps) {
  if (variant === "header") {
    return (
      <div data-testid="workflow-run-summary-row">
        <HeaderSummary
          execution={execution}
          isCanceling={isCanceling}
          onBack={onBack}
          onCancel={onCancel}
          runNumber={runNumber}
        />
      </div>
    );
  }

  return (
    <button
      className={cn(
        "w-full border-border border-b px-0 py-2.5 text-left transition-colors hover:bg-muted",
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
