import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import {
  getMissingRequiredFieldsForNodes,
  requiredFieldMessage,
  type ResolveActionByType,
} from "@wfgraph/shared/actions/action-config-validation";
import { ACTION_TYPE_CONFIG_KEY } from "@wfgraph/shared/graph/node-config";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { stepName } from "@wfgraph/shared/graph/step-name";
import {
  type StepNames,
  unnumberedStepNames,
} from "#src/backend/services/workflows/validation/step-names";

export type WorkflowActionValidationResult =
  | { valid: true }
  | { valid: false; error: string };

/**
 * The first step with a required field left blank, in the editor's words.
 * `names` numbers the step in the message; without it a step is named by its
 * label alone.
 */
export function validateWorkflowActionConfigs(
  nodes: WorkflowNode[],
  catalog: ExtensionCatalog,
  names: StepNames = unnumberedStepNames(catalog)
): WorkflowActionValidationResult {
  const resolveActionByType: ResolveActionByType = (actionType) =>
    findAction(catalog, actionType);

  const missingRequiredFields = getMissingRequiredFieldsForNodes({
    nodes,
    resolveActionByType,
  });

  if (missingRequiredFields.length > 0) {
    const [firstIssue] = missingRequiredFields;
    const number = names.numberOf(firstIssue.nodeId);
    const missingLabels = firstIssue.missingFields
      .map((field) => field.fieldLabel)
      .join(", ");

    // A missing action and a value that cannot be read are answered in the
    // editor's own sentences, so Publish and the issue list name the problem
    // in the same words.
    const sentenceField =
      firstIssue.missingFields.find(
        (field) => field.fieldKey === ACTION_TYPE_CONFIG_KEY
      ) ?? firstIssue.missingFields.find((field) => field.unreadable);
    if (sentenceField) {
      return {
        valid: false,
        error: requiredFieldMessage(
          firstIssue.stepLabel,
          sentenceField,
          number
        ),
      };
    }

    return {
      valid: false,
      error: `${stepName(firstIssue.stepLabel, number)} is missing required fields: ${missingLabels}`,
    };
  }

  return { valid: true };
}
