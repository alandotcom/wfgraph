/**
 * The Events a graph names, held to the rules a save is refused by.
 *
 * The vocabulary is the assembled catalog, which the caller reads off the
 * `Extensions` service, so this runs where a graph is written and again before a
 * run: an Event a workflow names has to be one the app still defines, whether the
 * entry node named it as a lifecycle role or a Wait node parks on it.
 */

import {
  type ExtensionCatalog,
  findEvent,
} from "@rova/shared/extensions/catalog";
import { BUILT_IN_ACTION_IDS } from "@rova/shared/actions/built-in-actions";
import {
  checkLifecycleRules,
  readLifecycleRules,
  unknownEventMessage,
} from "@rova/shared/lifecycle/lifecycle-rules";
import type { WorkflowNode } from "@rova/shared/graph/types";
import { readWaitSubscriptions } from "@rova/shared/lifecycle/wait-subscription";

export type WorkflowLifecycleValidationResult =
  | { valid: true }
  | { valid: false; error: string };

/**
 * Every Event a graph names, as the entry node's lifecycle role or a Wait
 * node's subscription, held to the same catalog.
 *
 * A graph whose entry node carries no rules passes: the panel writes them, and
 * refusing a graph that predates the panel would lock the editor out of the one
 * screen that can add them. A name neither role declares describes a wait that
 * no arrival can satisfy, so the run holds until its timeout with nothing said;
 * the editor offers only catalog Events, and this is the half of that rule an
 * API write also passes through.
 */
export function validateWorkflowEvents(
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): WorkflowLifecycleValidationResult {
  for (const node of nodes) {
    if (node.data.type === "trigger") {
      const rules = readLifecycleRules(node.data.config);
      if (rules) {
        const check = checkLifecycleRules({ rules, catalog });
        if (!check.valid) {
          return check;
        }
      }
      continue;
    }

    if (node.data.config?.actionType === BUILT_IN_ACTION_IDS.wait) {
      for (const subscription of readWaitSubscriptions(node.data.config)) {
        if (!findEvent(catalog, subscription.event)) {
          return {
            valid: false,
            error: unknownEventMessage(subscription.event),
          };
        }
      }
    }
  }

  return { valid: true };
}
