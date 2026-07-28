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
    <div className="divide-y">
      {executions.map((execution, index) => {
        const isSelected = selectedId === execution.id;
        const runNumber = executions.length - index;

        return (
          <WorkflowRunSummaryRow
            execution={execution}
            key={execution.id}
            leading={{ type: "spacer" }}
            onClick={() => onSelect(execution.id)}
            runNumber={runNumber}
            selected={isSelected}
            trailing={{ type: "spacer" }}
          />
        );
      })}
    </div>
  );
}
