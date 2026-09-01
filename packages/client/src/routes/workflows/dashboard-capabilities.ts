import { can, canInspectWorkflowRuns } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

/** Dashboard navigation needs the editor read and every run-detail read. */
export function readDashboardCapabilities() {
  const canOpenWorkflow = can(WfGraphOperations.workflowGetById.id);
  const canOpenGlobalRuns =
    can(WfGraphOperations.workflowGetExecutionsGlobal.id) &&
    canOpenWorkflow &&
    canInspectWorkflowRuns();

  return { canOpenWorkflow, canOpenGlobalRuns };
}
