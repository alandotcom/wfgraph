import { useAtomValue } from "jotai";
import { WorkflowOutline } from "#src/components/workflow/outline/workflow-outline";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { RunsOutline } from "./runs-outline";

/**
 * The editor's outline, which floats over the canvas on desktop and fills a
 * phone's screen. In Draft it holds the workflow's outline in run order. In
 * Runs it holds the run list, or the open run's outline.
 */
export function EditorOutline() {
  const view = useAtomValue(workflowWorkspaceViewAtom);
  if (view === "runs") {
    return <RunsOutline />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="outline-body">
      <WorkflowOutline />
    </div>
  );
}
