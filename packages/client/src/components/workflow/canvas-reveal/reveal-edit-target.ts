/**
 * Where keyboard focus goes in a Draft object's inspector when a person asks to
 * edit it, as the element id a Reveal field request names. Null names no
 * field, and the request focuses Reveal's title instead.
 */

import { getNodeMissingRequiredFields } from "@wfgraph/shared/actions/action-config-validation";
import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import { isConditionNode } from "@wfgraph/shared/graph/node-config";
import { isEventSplitNode } from "@wfgraph/shared/lifecycle/event-split";
import { ACTION_FILTER_ID } from "#src/components/workflow/config/action-grid";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { revealFocusTarget } from "./reveal-subject";

/** The element id of every Draft editor's Label field. */
const LABEL_TARGET_ID = "label";

/** Whether `node` is a step whose inspector shows the action picker. */
function showsActionPicker(node: WorkflowNode): boolean {
  return (
    node.data.type === "action" &&
    typeof node.data.config?.actionType !== "string"
  );
}

/**
 * The element a general edit of `node` focuses: the action picker's search
 * for a step with no action, nothing for an Event Split, which has no field,
 * and the label otherwise.
 */
export function editFocusTarget(node: WorkflowNode): string | null {
  if (showsActionPicker(node)) {
    return ACTION_FILTER_ID;
  }
  return isEventSplitNode(node) ? null : LABEL_TARGET_ID;
}

/**
 * The element a step just added focuses: the action picker's search, else the
 * first required field it leaves empty, else its label.
 */
export function newStepFocusTarget(
  node: WorkflowNode,
  catalog: ExtensionCatalog
): string | null {
  if (showsActionPicker(node) || node.data.type !== "action") {
    return editFocusTarget(node);
  }
  const [firstMissing] =
    getNodeMissingRequiredFields({
      node,
      resolveActionByType: (actionType) => findAction(catalog, actionType),
    })?.missingFields ?? [];
  if (!firstMissing) {
    return editFocusTarget(node);
  }
  return revealFocusTarget(
    isConditionNode(node) ? "condition" : "step",
    firstMissing.fieldKey
  );
}
