import { useAtomValue } from "jotai";
import { useState } from "react";
import { getRelativeTime } from "@wfgraph/shared/utils/time";
import { cn } from "@wfgraph/shared/utils";
import { Button } from "#src/components/ui/button";
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
import {
  getRunOutcome,
  WorkflowRunSummaryRow,
} from "./workflow-run-summary-row";
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

function waitingSummary(wait: ExecutionWait): string {
  if (wait.subscribedEvents.length > 0) {
    return `Waiting for ${wait.subscribedEvents.join(", ")}`;
  }
  if (wait.waitUntil) {
    return `Waiting until ${wait.waitUntil.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    })}`;
  }
  return "Waiting on a timer";
}

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
  const [returnFocusNodeId, setReturnFocusNodeId] = useState<string | null>(
    null
  );
  const sortedLogs = logs.toSorted(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );

  if (selectedNodeId) {
    return (
      <div className="h-full motion-safe:animate-[run-panel-forward_200ms_cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-[run-panel-fade_100ms_ease-out]">
        <WorkflowRunNodeInspector
          key={selectedNodeId}
          logs={sortedLogs}
          onBack={() => {
            if (returnFocusNodeId !== selectedNodeId) {
              setReturnFocusNodeId(null);
            }
          }}
        />
      </div>
    );
  }

  const failedLog = sortedLogs.findLast((log) => log.status === "error");
  const primaryWait = waits[0];
  const outcome =
    execution.status === "waiting" && primaryWait
      ? `Waiting at ${primaryWait.nodeName}`
      : getRunOutcome(execution, sortedLogs);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col motion-reduce:animate-[run-panel-fade_100ms_ease-out]",
        returnFocusNodeId
          ? "motion-safe:animate-[run-panel-back_160ms_cubic-bezier(0.16,1,0.3,1)]"
          : "motion-safe:animate-[run-panel-forward_200ms_cubic-bezier(0.16,1,0.3,1)]"
      )}
    >
      <WorkflowRunSummaryRow
        execution={execution}
        focusOnMount={returnFocusNodeId === null}
        isCanceling={isCanceling}
        onBack={onBack}
        onCancel={isRunInProgress(execution.status) ? onCancel : undefined}
        outcome={outcome}
        runNumber={runNumber}
        variant="header"
      />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 [scrollbar-gutter:stable_both-edges]">
        <div className="space-y-4">
          {notice ? (
            <p className="rounded-md border bg-muted/30 p-2 text-muted-foreground text-xs">
              {notice}
            </p>
          ) : null}

          {waits.length > 0 ? (
            <section className="space-y-3 rounded-md border border-warning/30 bg-warning/10 p-3">
              {waits.map((wait) => (
                <div className="space-y-1.5" key={wait.id}>
                  <h3 className="font-medium text-warning text-xs">
                    Waiting at {wait.nodeName}
                  </h3>
                  <p className="break-words text-xs">{waitingSummary(wait)}</p>
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
            </section>
          ) : null}

          {execution.status === "failed" && (failedLog || execution.error) ? (
            <section className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
              <h3 className="font-medium text-destructive text-xs">
                {failedLog
                  ? `Failed at ${failedLog.nodeName || failedLog.nodeType}`
                  : "Run failed"}
              </h3>
              <p className="mt-1 break-words text-destructive text-xs">
                {failedLog?.error ?? execution.error}
              </p>
            </section>
          ) : null}

          <WorkflowRunNodeIndex
            focusNodeId={returnFocusNodeId}
            logs={sortedLogs}
            onSelect={setReturnFocusNodeId}
          />

          {events.length > 0 ? (
            <CollapsibleSection title={`Activity · ${events.length}`}>
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
      </div>
    </div>
  );
}
