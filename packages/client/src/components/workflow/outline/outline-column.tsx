import { useAtomValue } from "jotai";
import { WorkflowOutline } from "#src/components/workflow/outline/workflow-outline";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { RunsColumn } from "./runs-column";

/**
 * The editor's outline, which floats over the canvas on desktop and fills a
 * phone's screen. In Draft it holds the workflow's outline in run order. In
 * Runs it holds the run list, or the open run's outline.
 */
export function OutlineColumn() {
  const view = useAtomValue(workflowWorkspaceViewAtom);
  if (view === "runs") {
    return <RunsColumn />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="outline-body">
      <WorkflowOutline />
    </div>
  );
}
