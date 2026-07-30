/**
 * The entry node's Lifecycle Rules, held to the rules a save is refused by.
 *
 * The vocabulary they are checked against is the assembled catalog, so this runs
 * where a graph is written and again before a run: an Event a workflow names has
 * to be one the app still defines.
 */

import { getExtensions } from "#src/backend/lib/extensions/current";
import {
  checkLifecycleRules,
  readLifecycleRules,
} from "@rova/shared/workflow/lifecycle-rules";
import type { WorkflowNode } from "@rova/shared/workflow/types";
import { readWaitEventNames } from "@rova/shared/workflow/wait-events";

export type WorkflowLifecycleValidationResult =
  | { valid: true }
  | { valid: false; error: string };

/**
 * A graph whose entry node carries no rules passes: the panel writes them, and
 * refusing a graph that predates the panel would lock the editor out of the one
 * screen that can add them.
 */
export function validateWorkflowLifecycleRules(
  nodes: readonly WorkflowNode[]
): WorkflowLifecycleValidationResult {
  const catalog = getExtensions().catalog;
  const waitEvents = readWaitEventNames(nodes);

  for (const node of nodes) {
    if (node.data.type !== "trigger") {
      continue;
    }

    const rules = readLifecycleRules(node.data.config);
    if (!rules) {
      continue;
    }

    const check = checkLifecycleRules({ rules, catalog, waitEvents });
    if (!check.valid) {
      return check;
    }
  }

  return { valid: true };
}
