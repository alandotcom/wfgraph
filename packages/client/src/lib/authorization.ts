import {
  type WfGraphOperationId,
  WfGraphOperations,
} from "@wfgraph/shared/authorization/operations";
import { hasAuthorizationGrant } from "#src/lib/extensions";

const WORKFLOW_RUN_INSPECTION_OPERATION_IDS = [
  WfGraphOperations.workflowGetExecutions.id,
  WfGraphOperations.workflowGetExecutionLogs.id,
  WfGraphOperations.workflowGetExecutionEvents.id,
  WfGraphOperations.workflowGetExecutionStatus.id,
  WfGraphOperations.workflowGetVersionGraph.id,
] as const;

/** Reads one operation from the page-lifetime authorization snapshot. */
export function can(operationId: WfGraphOperationId): boolean {
  return hasAuthorizationGrant(operationId);
}

/** Whether the editor can present a run and its pinned workflow graph. */
export function canInspectWorkflowRuns(): boolean {
  return WORKFLOW_RUN_INSPECTION_OPERATION_IDS.every(can);
}
