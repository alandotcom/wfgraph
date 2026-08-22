import { List } from "@astryxdesign/core/List";
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
    <List density="balanced" hasDividers>
      {executions.map((execution, index) => (
        <li key={execution.id}>
          <WorkflowRunSummaryRow
            execution={execution}
            leading={{ type: "spacer" }}
            onClick={() => onSelect(execution.id)}
            runNumber={executions.length - index}
            selected={selectedId === execution.id}
            trailing={{ type: "spacer" }}
          />
        </li>
      ))}
    </List>
  );
}
