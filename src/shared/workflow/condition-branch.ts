import type { ConditionBranch, WorkflowNode } from "@/shared/workflow/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeConditionBranch(
  value: unknown
): ConditionBranch | null {
  const raw = asTrimmedString(value);
  if (!raw) {
    return null;
  }

  const normalized = raw.toLowerCase();
  if (normalized === "true" || normalized === "false") {
    return normalized;
  }

  if (normalized === "branch-true") {
    return "true";
  }

  if (normalized === "branch-false") {
    return "false";
  }

  return null;
}

export function isExplicitConditionBranch(
  value: unknown
): value is ConditionBranch {
  return value === "true" || value === "false";
}

export function getConditionBranchDisplayLabel(value: unknown): string | null {
  const branch = normalizeConditionBranch(value);
  if (branch === "true") {
    return "True";
  }

  if (branch === "false") {
    return "False";
  }

  return null;
}

export function isConditionActionType(value: unknown): boolean {
  const actionType = asTrimmedString(value);
  if (!actionType) {
    return false;
  }

  return actionType.toLowerCase() === "condition";
}

export function isConditionActionNode(node: WorkflowNode | undefined): boolean {
  if (!node || node.data.type !== "action") {
    return false;
  }

  const config = asRecord(node.data.config);
  return isConditionActionType(config?.actionType);
}
