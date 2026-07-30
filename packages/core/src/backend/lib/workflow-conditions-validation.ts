import { checkCelBooleanExpression } from "#src/backend/lib/cel/environment";
import {
  compileConditionModel,
  compileSerializedConditionModel,
  parseConditionModel,
} from "@rova/shared/workflow/conditions";
import type { WorkflowNode } from "@rova/shared/workflow/types";
import { readWaitSubscriptions } from "@rova/shared/workflow/wait-subscription";

export type WorkflowConditionsValidationResult =
  | { valid: true }
  | { valid: false; error: string };

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getNodeLabel(node: WorkflowNode): string {
  const explicitLabel = node.data.label?.trim();
  if (explicitLabel) {
    return explicitLabel;
  }

  const actionType = node.data.config?.actionType;
  if (typeof actionType === "string" && actionType.trim()) {
    return actionType;
  }

  return node.id;
}

/**
 * Every Wait Subscription's match, held to the same bar a Condition node's is.
 *
 * The match compiles at park time rather than at save, so without this a model
 * the builder never finished would be found by a run that had already started
 * and had nowhere to go. There is no stored expression to compare against here:
 * the wait keeps the model alone, because half of what it compares is a value
 * only the run knows.
 *
 * A match whose operands are still blank is skipped, the same carve-out the
 * Condition node's empty expression gets: "Add a match" seeds a rule with an
 * empty value, and refusing that would refuse every autosave until the builder
 * typed one. Running is what requires it -- the action-config pass reports the
 * node as missing a required field, in preflight and in the editor alike.
 */
function validateWaitMatches(
  node: WorkflowNode,
  config: Record<string, unknown>
): WorkflowConditionsValidationResult {
  for (const subscription of readWaitSubscriptions(config)) {
    const match = asNonEmptyString(subscription.match);
    if (!match) {
      continue;
    }

    const compiled = compileSerializedConditionModel(match);
    if (!compiled.valid && !compiled.incomplete) {
      return {
        valid: false,
        error: `Node "${getNodeLabel(node)}" has an invalid match for "${subscription.event}": ${compiled.error}`,
      };
    }
  }

  return { valid: true };
}

function validateCompiledExpression(input: {
  node: WorkflowNode;
  expression: string;
  modelRaw: unknown;
  fieldName: "condition";
}): WorkflowConditionsValidationResult {
  const parsedModel = parseConditionModel(input.modelRaw);
  if (!parsedModel.valid) {
    return {
      valid: false,
      error: `Node "${getNodeLabel(input.node)}" has invalid ${input.fieldName} model: ${parsedModel.error}`,
    };
  }

  const compiled = compileConditionModel(parsedModel.model);
  if (!compiled.valid) {
    return {
      valid: false,
      error: `Node "${getNodeLabel(input.node)}" has invalid ${input.fieldName} model: ${compiled.error}`,
    };
  }

  if (compiled.expression !== input.expression) {
    return {
      valid: false,
      error: `Node "${getNodeLabel(input.node)}" has ${input.fieldName} CEL that does not match its structured model`,
    };
  }

  const celValidation = checkCelBooleanExpression(input.expression);
  if (!celValidation.ok) {
    return {
      valid: false,
      error: `Node "${getNodeLabel(input.node)}" has invalid ${input.fieldName} CEL: ${celValidation.error}`,
    };
  }

  return { valid: true };
}

export function validateWorkflowConditionConfigs(
  nodes: WorkflowNode[]
): WorkflowConditionsValidationResult {
  for (const node of nodes) {
    if (node.data.type !== "action") {
      continue;
    }

    const config = node.data.config;
    if (!config || typeof config !== "object") {
      continue;
    }

    const actionType =
      typeof config.actionType === "string" ? config.actionType : "";

    if (actionType === "Condition") {
      // The builder writes an empty expression while a rule is still incomplete,
      // so an empty one marks a node the user is mid-way through rather than a
      // broken one. Running is what requires it: preflight's action-config pass
      // reports the node as missing a required field, and the editor shows the
      // same issue and blocks Run.
      const conditionExpression = asNonEmptyString(config.condition);
      if (!conditionExpression) {
        continue;
      }

      const conditionModel = asNonEmptyString(config.conditionModel);
      if (!conditionModel) {
        return {
          valid: false,
          error: `Node "${getNodeLabel(node)}" must be configured with the structured condition builder`,
        };
      }

      const conditionValidation = validateCompiledExpression({
        node,
        expression: conditionExpression,
        modelRaw: conditionModel,
        fieldName: "condition",
      });
      if (!conditionValidation.valid) {
        return conditionValidation;
      }
    }

    if (actionType === "Wait") {
      const matchValidation = validateWaitMatches(node, config);
      if (!matchValidation.valid) {
        return matchValidation;
      }
    }
  }

  return { valid: true };
}
