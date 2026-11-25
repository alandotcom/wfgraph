/**
 * What a test run does at one step, as one sentence the build agent reads,
 * from the rule `stepTestRunBehavior` states.
 */

import { stepTestRunBehavior } from "@wfgraph/shared/actions/test-run-behavior";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";

const BUILT_IN_STEP =
  "Runs as it does in a live run. It reaches nothing outside the workflow.";

const HANDLER_DECIDES =
  'Has no "In test runs" setting. A test run still calls this step\'s handler, and the action\'s own handler decides whether it does its work; a step it skipped shows as "Skipped (test run)" in that run.';

/**
 * The sentence for `node`, or undefined for a node that is not an action step
 * or names an action the catalog does not hold.
 */
export function testRunBehavior(
  node: WorkflowNode,
  catalog: ExtensionCatalog
): string | undefined {
  const behavior = stepTestRunBehavior(node, catalog);
  if (behavior === undefined) {
    return undefined;
  }
  if (behavior.kind === "built-in") {
    return BUILT_IN_STEP;
  }
  if (behavior.kind === "handler-decides") {
    return HANDLER_DECIDES;
  }
  if (behavior.kind === "setting-unset") {
    return `Follows its "${behavior.settingLabel}" setting, which holds no option.`;
  }
  const shown = behavior.shownFields.map((field) =>
    field.value === null
      ? ` ${field.label} is empty.`
      : ` ${field.label} is ${field.value}.`
  );
  return `Follows its "${behavior.settingLabel}" setting, set to ${JSON.stringify(behavior.optionLabel)}.${shown.join("")}`;
}
