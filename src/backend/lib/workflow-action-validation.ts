import type { WorkflowNode } from "@/shared/workflow/types";

export type WorkflowActionValidationResult =
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
  const explicitLabel = asNonEmptyString(node.data.label);
  if (explicitLabel) {
    return explicitLabel;
  }

  const configuredAction = asNonEmptyString(node.data.config?.actionType);
  if (configuredAction) {
    return configuredAction;
  }

  return node.id;
}

export function validateWorkflowActionConfigs(
  nodes: WorkflowNode[]
): WorkflowActionValidationResult {
  for (const node of nodes) {
    if (node.data.type !== "action") {
      continue;
    }

    if (node.data.enabled === false) {
      continue;
    }

    const actionType = asNonEmptyString(node.data.config?.actionType);
    if (!actionType) {
      return {
        valid: false,
        error: `Node "${getNodeLabel(node)}" has no action selected`,
      };
    }
  }

  return { valid: true };
}
