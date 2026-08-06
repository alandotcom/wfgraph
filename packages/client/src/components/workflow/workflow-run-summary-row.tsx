import { ArrowLeft, Ban, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "#src/components/ui/button";
import { cn } from "@rova/shared/utils";
import { getRelativeTime } from "@rova/shared/utils/time";
import { type WorkflowExecution } from "#src/lib/execution-logs";
import {
  formatDuration,
  getStatusBadgeClass,
  getStatusDotClass,
  getStatusLabel,
} from "./workflow-run-shared";

type LeadingSlot =
  | {
      type: "spacer";
    }
  | {
      type: "back";
      onBack: () => void;
    };

type TrailingSlot =
  | {
      type: "spacer";
    }
  | {
      type: "cancel";
      isCanceling: boolean;
      onCancel: (executionId: string) => void;
    };

type WorkflowRunSummaryRowProps = {
  execution: WorkflowExecution;
  runNumber: number;
  leading: LeadingSlot;
  trailing: TrailingSlot;
  onClick?: () => void;
  selected?: boolean;
  showStartEventName?: boolean;
};

const ROW_LAYOUT_CLASS =
  "grid w-full grid-cols-[1.5rem_minmax(0,1fr)_5rem] items-start gap-3 px-1 py-3 text-left";

function renderLeadingSlot(leading: LeadingSlot): ReactNode {
  if (leading.type === "back") {
    return (
      <button
        aria-label="Back to runs list"
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted"
        onClick={leading.onBack}
        type="button"
      >
        <ArrowLeft className="size-4 text-muted-foreground" />
      </button>
    );
  }

  return <div aria-hidden className="size-6 shrink-0" />;
}

function renderTrailingSlot(
  execution: WorkflowExecution,
  trailing: TrailingSlot
): ReactNode {
  if (trailing.type === "cancel") {
    return (
      <div className="flex w-20 justify-end">
        <Button
          className="w-full"
          disabled={trailing.isCanceling}
          onClick={() => trailing.onCancel(execution.id)}
          size="sm"
          variant="outline"
        >
          {trailing.isCanceling ? (
            <Loader2 className="mr-1 size-3 animate-spin" />
          ) : (
            <Ban className="mr-1 size-3" />
          )}
          Cancel
        </Button>
      </div>
    );
  }

  return <div aria-hidden className="w-20 shrink-0" />;
}

function SummaryContent({
  execution,
  runNumber,
  showStartEventName,
}: Pick<
  WorkflowRunSummaryRowProps,
  "execution" | "runNumber" | "showStartEventName"
>) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div
        className={cn(
          "mt-1 size-2.5 shrink-0 rounded-full",
          getStatusDotClass(execution.status)
        )}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">Run #{runNumber}</span>
          <span
            className={cn(
              "rounded border px-1.5 py-0.5 font-medium text-xs uppercase",
              getStatusBadgeClass(execution.status)
            )}
          >
            {getStatusLabel(execution.status)}
          </span>
          {execution.runMode === "test" ? (
            <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-medium text-xs text-warning uppercase">
              Test Mode
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-muted-foreground text-xs">
          <span>{getRelativeTime(execution.startedAt)}</span>
          {execution.startSource ? (
            <>
              <span>·</span>
              <span className="capitalize">{execution.startSource}</span>
            </>
          ) : null}
          {showStartEventName && execution.startEventName ? (
            <>
              <span>·</span>
              <span>{execution.startEventName}</span>
            </>
          ) : null}
          {execution.duration ? (
            <>
              <span>·</span>
              <span className="font-mono tabular-nums">
                {formatDuration(execution.duration)}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function WorkflowRunSummaryRow({
  execution,
  runNumber,
  leading,
  trailing,
  onClick,
  selected = false,
  showStartEventName = false,
}: WorkflowRunSummaryRowProps) {
  const content = (
    <>
      {renderLeadingSlot(leading)}
      <SummaryContent
        execution={execution}
        runNumber={runNumber}
        showStartEventName={showStartEventName}
      />
      {renderTrailingSlot(execution, trailing)}
    </>
  );

  if (onClick) {
    return (
      <button
        className={cn(
          ROW_LAYOUT_CLASS,
          "transition-colors hover:bg-muted/50",
          selected && "bg-muted/50"
        )}
        data-testid="workflow-run-summary-row"
        onClick={onClick}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <div className={ROW_LAYOUT_CLASS} data-testid="workflow-run-summary-row">
      {content}
    </div>
  );
}
