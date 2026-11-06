import { useRef } from "react";
import type { WorkflowExecution } from "#src/lib/execution-logs";
import { useAfterCommit } from "#src/hooks/effects";
import { WorkflowRunSummaryRow } from "./workflow-run-summary-row";
import { useRunListClock } from "./use-run-list-clock";
import { listActivityLabel } from "#src/lib/run-executor-activity";

type WorkflowRunsListProps = {
  executions: WorkflowExecution[];
  onSelect: (executionId: string) => void;
  /** The run whose row takes focus, or null. */
  focusId: string | null;
  /** Called once the list has looked for the row of `focusId`, with whether it focused one. */
  onFocusAnswered: (focused: boolean) => void;
  /** The browser's clock when `executions` arrived. */
  receivedAtMs: number;
};

export function WorkflowRunsList({
  executions,
  onSelect,
  focusId,
  onFocusAnswered,
  receivedAtMs,
}: WorkflowRunsListProps) {
  const rowsRef = useRef(new Map<string, HTMLDivElement>());
  const serverNowMs = useRunListClock({
    activities: executions.map((execution) => execution.activity),
    receivedAtMs,
  });

  useAfterCommit(focusId, () => {
    if (!focusId) {
      return;
    }
    const row = rowsRef.current.get(focusId)?.querySelector("button") ?? null;
    row?.focus();
    onFocusAnswered(row !== null);
  });

  return (
    <div>
      {executions.map((execution, index) => (
        <div
          key={execution.id}
          ref={(element) => {
            if (element) {
              rowsRef.current.set(execution.id, element);
            } else {
              rowsRef.current.delete(execution.id);
            }
          }}
        >
          <WorkflowRunSummaryRow
            execution={execution}
            activityLabel={listActivityLabel(execution.activity, serverNowMs)}
            onClick={() => onSelect(execution.id)}
            runNumber={executions.length - index}
          />
        </div>
      ))}
    </div>
  );
}
