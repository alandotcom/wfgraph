/**
 * Which line out of a Condition node an edge leaves by, and what marks the node
 * itself.
 *
 * Both comparisons are exact, which is what the engine's own dispatch compares
 * with. A reader that accepted `condition` where the engine wants `Condition`
 * would call a node a Condition that the engine then fans out from as an
 * unimplemented action.
 */

import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import type { ConditionBranch, WorkflowNode } from "#src/graph/types";

export function normalizeConditionBranch(
  value: unknown
): ConditionBranch | null {
  return value === "true" || value === "false" ? value : null;
}

export function getConditionBranchDisplayLabel(value: unknown): string | null {
  const branch = normalizeConditionBranch(value);
  if (branch === "true") {
    return "True";
  }

  return branch === "false" ? "False" : null;
}

export function isConditionActionType(value: unknown): boolean {
  return value === BUILT_IN_ACTION_IDS.condition;
}

export function isConditionActionNode(node: WorkflowNode | undefined): boolean {
  if (!node || node.data.type !== "action") {
    return false;
  }

  return isConditionActionType(node.data.config?.actionType);
}
