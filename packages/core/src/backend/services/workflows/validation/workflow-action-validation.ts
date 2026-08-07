import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import {
  getMissingRequiredFieldsForNodes,
  type ResolveActionByType,
} from "@wfgraph/shared/actions/action-config-validation";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";

export type WorkflowActionValidationResult =
  | { valid: true }
  | { valid: false; error: string };

export function validateWorkflowActionConfigs(
  nodes: WorkflowNode[],
  catalog: ExtensionCatalog
): WorkflowActionValidationResult {
  const resolveActionByType: ResolveActionByType = (actionType) =>
    findAction(catalog, actionType);

  const missingRequiredFields = getMissingRequiredFieldsForNodes({
    nodes,
    resolveActionByType,
  });

  if (missingRequiredFields.length > 0) {
    const [firstIssue] = missingRequiredFields;
    const missingLabels = firstIssue.missingFields
      .map((field) => field.fieldLabel)
      .join(", ");

    if (
      firstIssue.missingFields.some((field) => field.fieldKey === "actionType")
    ) {
      return {
        valid: false,
        error: `Node "${firstIssue.nodeLabel}" has no action selected`,
      };
    }

    return {
      valid: false,
      error: `Node "${firstIssue.nodeLabel}" is missing required fields: ${missingLabels}`,
    };
  }

  return { valid: true };
}
