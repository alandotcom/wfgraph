import { getRelativeTime } from "@rova/shared/utils/time";
import {
  type ExecutionEvent,
  type ExecutionLog,
  type WorkflowExecution,
} from "@/lib/execution-logs";
import { CollapsibleSection } from "./workflow-run-shared";
import { WorkflowRunSummaryRow } from "./workflow-run-summary-row";
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
      <WorkflowRunSummaryRow
        execution={execution}
        leading={{ onBack, type: "back" }}
        runNumber={runNumber}
        showTriggerEventType
        trailing={
          execution.status === "waiting"
            ? {
                isCanceling,
                onCancel,
                type: "cancel",
              }
            : { type: "spacer" }
        }
      />

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
