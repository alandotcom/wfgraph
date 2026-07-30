import { BUILT_IN_ACTION_IDS } from "#src/workflow/built-in-actions";
import type { ConditionBranch, WorkflowNode } from "#src/workflow/types";

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

  return (
    actionType.toLowerCase() === BUILT_IN_ACTION_IDS.condition.toLowerCase()
  );
}

export function isConditionActionNode(node: WorkflowNode | undefined): boolean {
  if (!node || node.data.type !== "action") {
    return false;
  }

  return isConditionActionType(node.data.config?.actionType);
}
