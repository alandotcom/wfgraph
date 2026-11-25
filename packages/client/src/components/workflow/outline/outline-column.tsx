import { useAtomValue } from "jotai";
import { ColumnHeader } from "#src/components/workflow/columns/editor-columns";
import { WorkflowOutline } from "#src/components/workflow/outline/workflow-outline";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { RunsColumn } from "./runs-column";

/**
 * The editor's left column. In Draft it holds the workflow's outline in run
 * order. In Runs it holds the run list, or the open run's outline.
 */
export function OutlineColumn() {
  const view = useAtomValue(workflowWorkspaceViewAtom);
  if (view === "runs") {
    return <RunsColumn />;
  }
  return (
    <>
      <ColumnHeader side="outline">
        <h2 className="font-medium text-sm">Outline</h2>
      </ColumnHeader>
      <div className="min-h-0 flex-1 overflow-hidden" data-slot="outline-body">
        <WorkflowOutline />
      </div>
    </>
  );
}
