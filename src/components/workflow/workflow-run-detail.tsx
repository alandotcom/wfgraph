import { ArrowLeft, Ban, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/utils";
import { getRelativeTime } from "@/shared/utils/time";
import {
  CollapsibleSection,
  type ExecutionEvent,
  type ExecutionLog,
  formatDuration,
  getStatusBadgeClass,
  getStatusDotClass,
  getStatusLabel,
  type WorkflowExecution,
} from "./workflow-run-shared";
import { WorkflowRunTimeline } from "./workflow-run-timeline";

type WorkflowRunDetailProps = {
  execution: WorkflowExecution;
  runNumber: number;
  logs: ExecutionLog[];
  events: ExecutionEvent[];
  isCanceling: boolean;
  onBack: () => void;
  onCancel: (executionId: string) => void;
};

export function WorkflowRunDetail({
  execution,
  runNumber,
  logs,
  events,
  isCanceling,
  onBack,
  onCancel,
}: WorkflowRunDetailProps) {
  const sortedLogs = logs.toSorted(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          className="flex shrink-0 items-center justify-center rounded-md p-1 transition-colors hover:bg-muted"
          onClick={onBack}
          type="button"
        >
          <ArrowLeft className="size-4 text-muted-foreground" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "size-2.5 shrink-0 rounded-full",
                getStatusDotClass(execution.status)
              )}
            />
            <span className="font-semibold text-sm">Run #{runNumber}</span>
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
          <div className="mt-1 flex items-center gap-2 text-muted-foreground text-xs">
            <span>{getRelativeTime(execution.startedAt)}</span>
            {execution.triggerType ? (
              <>
                <span>·</span>
                <span className="capitalize">{execution.triggerType}</span>
              </>
            ) : null}
            {execution.triggerEventType ? (
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
        {execution.status === "waiting" ? (
          <Button
            disabled={isCanceling}
            onClick={() => onCancel(execution.id)}
            size="sm"
            variant="outline"
          >
            {isCanceling ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Ban className="mr-1 h-3 w-3" />
            )}
            Cancel
          </Button>
        ) : null}
      </div>

      {/* Timeline */}
      <WorkflowRunTimeline logs={sortedLogs} />

      {/* Audit events */}
      {events.length > 0 ? (
        <CollapsibleSection title="Audit Events">
          <div className="space-y-2">
            {events.map((event) => (
              <div
                className="flex items-center justify-between rounded-md border bg-muted/30 px-2 py-1.5"
                key={event.id}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-xs">
                    {event.message}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {event.eventType}
                  </div>
                </div>
                <div className="ml-3 shrink-0 text-[11px] text-muted-foreground">
                  {getRelativeTime(event.createdAt)}
                </div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      ) : null}
    </div>
  );
}
