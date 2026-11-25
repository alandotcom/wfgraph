/**
 * What a test run does at one step. A Draft run, and a run of a published
 * version in Test mode, calls every step's handler with runMode "test". An
 * action declaring an "In test runs" select (config key `testBehavior`) acts
 * on the option the step holds, or on the field's default when it holds none,
 * and its "log_only" option does nothing. Any other action's handler decides
 * for itself, and nothing in the catalog says what it decides. The build
 * agent's tools and the Run dialog both read this one rule.
 */

import { isBuiltInActionId } from "#src/actions/built-in-actions";
import { type ExtensionCatalog, findAction } from "#src/extensions/catalog";
import { actionTypeOf } from "#src/graph/node-config";
import type { WorkflowNode } from "#src/graph/types";
import { flattenConfigFields } from "#src/plugins/action-fields";
import { matchesShowWhen } from "#src/types/show-when";
import { isBlank } from "#src/types/string";

/** The config key every built-in integration gives its "In test runs" select. */
const TEST_BEHAVIOR_KEY = "testBehavior";

/** The "In test runs" option that does nothing, in every built-in integration. */
const LOG_ONLY = "log_only";

/** A field the chosen option shows, such as the test phone number it sends to. */
export type TestRunShownField = {
  label: string;
  /** The value as a sentence quotes it, or null when the field is empty. */
  value: string | null;
};

export type StepTestRunBehavior =
  /** A built-in step, which reaches nothing outside the workflow. */
  | { kind: "built-in" }
  /** An action with no "In test runs" setting: its handler decides. */
  | { kind: "handler-decides" }
  /** An action with the setting, which holds no option and has no default. */
  | { kind: "setting-unset"; settingLabel: string }
  /** An action following the option its setting holds. */
  | {
      kind: "setting";
      settingLabel: string;
      /** The option's label, or its value when the options list lacks it. */
      optionLabel: string;
      /** Whether the option is the one that does nothing. */
      skips: boolean;
      shownFields: readonly TestRunShownField[];
    };

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
 * What a test run does at `node`, or undefined for a node that is not an
 * action step or names an action the catalog does not hold.
 */
export function stepTestRunBehavior(
  node: WorkflowNode,
  catalog: ExtensionCatalog
): StepTestRunBehavior | undefined {
  const actionId = actionTypeOf(node);
  if (node.data.type !== "action" || actionId === undefined) {
    return undefined;
  }
  if (isBuiltInActionId(actionId)) {
    return { kind: "built-in" };
  }
  const action = findAction(catalog, actionId);
  if (action === undefined) {
    return undefined;
  }
  const fields = flattenConfigFields(action.configFields);
  const setting = fields.find((field) => field.key === TEST_BEHAVIOR_KEY);
  if (setting === undefined) {
    return { kind: "handler-decides" };
  }

  const config = node.data.config ?? {};
  const held = config[setting.key];
  const chosen =
    typeof held === "string" && !isBlank(held) ? held : setting.defaultValue;
  if (chosen === undefined) {
    return { kind: "setting-unset", settingLabel: setting.label };
  }
  const option = setting.options?.find((entry) => entry.value === chosen);
  const resolved = { ...config, [setting.key]: chosen };
  return {
    kind: "setting",
    settingLabel: setting.label,
    optionLabel: option?.label ?? chosen,
    skips: chosen === LOG_ONLY,
    shownFields: fields
      .filter(
        (field) =>
          field.showWhen?.field === setting.key &&
          matchesShowWhen(resolved, field.showWhen)
      )
      .map((field) => ({
        label: field.label,
        value: quotedValue(config[field.key]),
      })),
  };
}
