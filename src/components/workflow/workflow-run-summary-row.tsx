import { ArrowLeft, Ban, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/utils";
import { getRelativeTime } from "@/shared/utils/time";
import {
  formatDuration,
  getStatusBadgeClass,
  getStatusDotClass,
  getStatusLabel,
  type WorkflowExecution,
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
  showTriggerEventType?: boolean;
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
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Ban className="mr-1 h-3 w-3" />
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
  showTriggerEventType,
}: Pick<
  WorkflowRunSummaryRowProps,
  "execution" | "runNumber" | "showTriggerEventType"
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
              "rounded border px-1.5 py-0.5 font-medium text-[10px] uppercase",
              getStatusBadgeClass(execution.status)
            )}
          >
            {getStatusLabel(execution.status)}
          </span>
          {execution.isDryRun ? (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-medium text-[10px] text-amber-700 uppercase dark:text-amber-300">
              Dry Run
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-muted-foreground text-xs">
          <span>{getRelativeTime(execution.startedAt)}</span>
          {execution.triggerType ? (
            <>
              <span>·</span>
              <span className="capitalize">{execution.triggerType}</span>
            </>
          ) : null}
          {showTriggerEventType && execution.triggerEventType ? (
            <>
              <span>·</span>
              <span>{execution.triggerEventType}</span>
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
  showTriggerEventType = false,
}: WorkflowRunSummaryRowProps) {
  const content = (
    <>
      {renderLeadingSlot(leading)}
      <SummaryContent
        execution={execution}
        runNumber={runNumber}
        showTriggerEventType={showTriggerEventType}
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
