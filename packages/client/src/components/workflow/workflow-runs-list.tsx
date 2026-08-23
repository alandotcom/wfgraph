import type { WorkflowExecution } from "#src/lib/execution-logs";
import { WorkflowRunSummaryRow } from "./workflow-run-summary-row";

type WorkflowRunsListProps = {
  executions: WorkflowExecution[];
  selectedId: string | null;
  onSelect: (executionId: string) => void;
};

export function WorkflowRunsList({
  executions,
  selectedId,
  onSelect,
}: WorkflowRunsListProps) {
  return (
    <div>
      {executions.map((execution, index) => {
        const selected = selectedId === execution.id;
        const runNumber = executions.length - index;

        return (
          <WorkflowRunSummaryRow
            execution={execution}
            key={execution.id}
            onClick={() => onSelect(execution.id)}
            runNumber={runNumber}
            selected={selected}
          />
        );
      })}
    </div>
  );
}
