/**
 * What a test run does at one step, as one sentence the build agent reads.
 *
 * A Draft run, and a run of a published version in Test mode, calls every
 * step's handler with runMode "test". An action declaring an "In test runs"
 * select (config key `testBehavior`) acts on the option the step holds, or on
 * the field's default when it holds none. Any other action's handler decides
 * for itself, and nothing in the catalog says what it decides.
 */

import { isBuiltInActionId } from "@wfgraph/shared/actions/built-in-actions";
import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import { matchesShowWhen } from "@wfgraph/shared/types/show-when";
import { isBlank } from "@wfgraph/shared/types/string";

/** The config key every built-in integration gives its "In test runs" select. */
const TEST_BEHAVIOR_KEY = "testBehavior";

const BUILT_IN_STEP =
  "Runs as it does in a live run. It reaches nothing outside the workflow.";

const HANDLER_DECIDES =
  'Has no "In test runs" setting. A test run still calls this step\'s handler, and the action\'s own handler decides whether it does its work; a step it skipped shows as "Skipped (test run)" in that run.';

/** A config value as a sentence names it. */
function quotedValue(value: unknown): string | null {
  if (typeof value === "string") {
    return isBlank(value) ? null : JSON.stringify(value);
  }
  return typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : null;
}

/**
 * The sentence for `node`, or undefined for a node that is not an action step
 * or names an action the catalog does not hold.
 */
export function testRunBehavior(
  node: WorkflowNode,
  catalog: ExtensionCatalog
): string | undefined {
  const actionId = actionTypeOf(node);
  if (node.data.type !== "action" || actionId === undefined) {
    return undefined;
  }
  if (isBuiltInActionId(actionId)) {
    return BUILT_IN_STEP;
  }
  const action = findAction(catalog, actionId);
  if (action === undefined) {
    return undefined;
  }
  const fields = flattenConfigFields(action.configFields);
  const setting = fields.find((field) => field.key === TEST_BEHAVIOR_KEY);
  if (setting === undefined) {
    return HANDLER_DECIDES;
  }

  const config = node.data.config ?? {};
  const held = config[setting.key];
  const chosen =
    typeof held === "string" && !isBlank(held) ? held : setting.defaultValue;
  if (chosen === undefined) {
    return `Follows its "${setting.label}" setting, which holds no option.`;
  }
  const option = setting.options?.find((entry) => entry.value === chosen);
  // The fields the chosen option shows, such as the test phone number a
  // "Send to test phone" option sends to, which say who a test run reaches.
  const resolved = { ...config, [setting.key]: chosen };
  const shown = fields
    .filter(
      (field) =>
        field.showWhen?.field === setting.key &&
        matchesShowWhen(resolved, field.showWhen)
    )
    .map((field) => {
      const value = quotedValue(config[field.key]);
      return value === null
        ? ` ${field.label} is empty.`
        : ` ${field.label} is ${value}.`;
    });
  return `Follows its "${setting.label}" setting, set to ${JSON.stringify(option?.label ?? chosen)}.${shown.join("")}`;
}
