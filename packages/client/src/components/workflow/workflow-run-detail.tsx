import { useAtomValue } from "jotai";
import { getRelativeTime } from "@wfgraph/shared/utils/time";
import { Button } from "#src/components/ui/button";
import { ConfigSection } from "#src/components/workflow/config/config-section";
import {
  type ExecutionEvent,
  type ExecutionLog,
  type ExecutionWait,
  isRunInProgress,
  type WorkflowExecution,
} from "#src/lib/execution-logs";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import { CollapsibleSection } from "./workflow-run-shared";
import { WorkflowRunNodeInspector } from "./workflow-run-node-inspector";
import { WorkflowRunSummaryRow } from "./workflow-run-summary-row";
import { WorkflowRunNodeIndex } from "./workflow-run-timeline";

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

const ignoreEditingChange = (_editing: boolean) => undefined;

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
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const sortedLogs = logs.toSorted(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );

  if (selectedNodeId) {
    return <WorkflowRunNodeInspector logs={sortedLogs} />;
  }

  return (
    <div className="space-y-4">
      <WorkflowRunSummaryRow
        execution={execution}
        isCanceling={isCanceling}
        onBack={onBack}
        onCancel={isRunInProgress(execution.status) ? onCancel : undefined}
        runNumber={runNumber}
        variant="header"
      />

      {notice ? (
        <p className="rounded-md border bg-muted/30 p-2 text-muted-foreground text-xs">
          {notice}
        </p>
      ) : null}

      {waits.length > 0 ? (
        <ConfigSection
          editable={false}
          editing={false}
          label="Waiting"
          onEditingChange={ignoreEditingChange}
          view={
            <div className="space-y-3">
              {waits.map((wait) => (
                <div className="space-y-1.5" key={wait.id}>
                  <p className="font-medium text-xs">
                    Parked at {wait.nodeName}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {wait.subscribedEvents.length > 0
                      ? `Waiting for ${wait.subscribedEvents.join(", ")}`
                      : "Waiting on a timer"}
                  </p>
                  {wait.resumeToken ? (
                    <Button
                      disabled={isResuming}
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
            </div>
          }
        >
          {null}
        </ConfigSection>
      ) : null}

      <WorkflowRunNodeIndex logs={sortedLogs} />

      {events.length > 0 ? (
        <CollapsibleSection title="Audit Events">
          <div className="space-y-2">
            {events.map((event) => (
              <div
                className="flex items-center justify-between gap-2"
                key={event.id}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-xs">
                    {event.message}
                  </div>
                  <div className="truncate text-muted-foreground text-xs">
                    {event.eventType}
                  </div>
                </div>
                <div className="shrink-0 text-muted-foreground text-xs">
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
