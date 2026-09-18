import { useRef } from "react";
import type { WorkflowExecution } from "#src/lib/execution-logs";
import { useAfterCommit } from "#src/hooks/effects";
import { WorkflowRunSummaryRow } from "./workflow-run-summary-row";

type WorkflowRunsListProps = {
  executions: WorkflowExecution[];
  onSelect: (executionId: string) => void;
  /** The run whose row takes focus, or null. */
  focusId: string | null;
  /** Called once the list has looked for the row of `focusId`, with whether it focused one. */
  onFocusAnswered: (focused: boolean) => void;
};

export function WorkflowRunsList({
  executions,
  onSelect,
  focusId,
  onFocusAnswered,
}: WorkflowRunsListProps) {
  const rowsRef = useRef(new Map<string, HTMLDivElement>());

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
            onClick={() => onSelect(execution.id)}
            runNumber={executions.length - index}
          />
        </div>
      ))}
    </div>
  );
}
