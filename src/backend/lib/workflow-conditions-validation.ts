import { checkCelBooleanExpression } from "@/backend/lib/cel/environment";
import {
  compileConditionModel,
  parseConditionModel,
} from "@/shared/workflow/conditions";
import type { WorkflowNode } from "@/shared/workflow/types";

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
      const conditionExpression = asNonEmptyString(config.condition);
      if (!conditionExpression) {
        return {
          valid: false,
          error: `Node "${getNodeLabel(node)}" requires a CEL condition expression`,
        };
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
  }

  return { valid: true };
}
