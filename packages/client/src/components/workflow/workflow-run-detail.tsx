import { getRelativeTime } from "@wfgraph/shared/utils/time";
import { Button } from "#src/components/ui/button";
import {
  type ExecutionEvent,
  type ExecutionLog,
  type ExecutionWait,
  isRunInProgress,
  type WorkflowExecution,
} from "#src/lib/execution-logs";
import { CollapsibleSection } from "./workflow-run-shared";
import { WorkflowRunSummaryRow } from "./workflow-run-summary-row";
import { WorkflowRunTimeline } from "./workflow-run-timeline";

type WorkflowRunDetailProps = {
  execution: WorkflowExecution;
  runNumber: number;
  /** Why this run is no longer in the list behind it, when it has left. */
  notice?: string;
  logs: ExecutionLog[];
  events: ExecutionEvent[];
  waits: ExecutionWait[];
  isCanceling: boolean;
  isResuming: boolean;
  onBack: () => void;
  onCancel: (executionId: string) => void;
  onResume: (token: string) => void;
};

export function WorkflowRunDetail({
  execution,
  runNumber,
  notice,
  logs,
  events,
  waits,
  isCanceling,
  isResuming,
  onBack,
  onCancel,
  onResume,
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
        showStartEventName
        trailing={
          isRunInProgress(execution.status)
            ? {
                isCanceling,
                onCancel,
                type: "cancel",
              }
            : { type: "spacer" }
        }
      />

      {notice ? (
        <p className="rounded-md border bg-muted/30 p-2 text-muted-foreground text-xs">
          {notice}
        </p>
      ) : null}

      {waits.map((wait) => (
        <div
          className="space-y-1.5 rounded-md border bg-muted/30 p-2"
          key={wait.id}
        >
          <p className="font-medium text-xs">Parked at {wait.nodeName}</p>
          <p className="text-xs text-muted-foreground">
            {wait.subscribedEvents.length > 0
              ? `Waiting for ${wait.subscribedEvents.join(", ")}`
              : "Waiting on a timer"}
          </p>
          {wait.resumeToken ? (
            <Button
              disabled={isResuming}
              // The operator's way past an Event that is never going to come.
              // It carries no payload, so a match downstream of it reads an
              // empty object; that is the point of forcing the run onward.
              onClick={() => onResume(wait.resumeToken ?? "")}
              size="sm"
              type="button"
              variant="outline"
            >
              Resume now
            </Button>
          ) : null}
        </div>
      ))}

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
                  <div className="truncate text-xs text-muted-foreground">
                    {event.eventType}
                  </div>
                </div>
                <div className="ml-3 shrink-0 text-xs text-muted-foreground">
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
