import { useRef } from "react";
import type { WorkflowExecution } from "#src/lib/execution-logs";
import { useAfterCommit } from "#src/hooks/effects";
import { WorkflowRunSummaryRow } from "./workflow-run-summary-row";

type WorkflowRunsListProps = {
  executions: WorkflowExecution[];
  selectedId: string | null;
  onSelect: (executionId: string) => void;
  focusId?: string | null;
};

export function WorkflowRunsList({
  executions,
  selectedId,
  onSelect,
  focusId,
}: WorkflowRunsListProps) {
  const rowsRef = useRef(new Map<string, HTMLDivElement>());

  useAfterCommit(focusId, () => {
    if (!focusId) {
      return;
    }
    rowsRef.current.get(focusId)?.querySelector("button")?.focus();
  });

  return (
    <div>
      {executions.map((execution, index) => {
        const selected = selectedId === execution.id;
        const runNumber = executions.length - index;

        return (
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
              runNumber={runNumber}
              selected={selected}
            />
          </div>
        );
      })}
    </div>
  );
}
