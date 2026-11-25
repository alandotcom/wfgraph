import { asNonEmptyString, isBlank } from "#src/types/string";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import { WAIT_FIELD_LABELS } from "#src/actions/wait-field-labels";
import { compileSerializedConditionModel } from "#src/conditions/conditions";
import { ACTION_TYPE_CONFIG_KEY } from "#src/graph/node-config";
import { findTemplateTokens } from "#src/graph/node-references";
import {
  readWaitDelayTiming,
  readWaitSubscriptions,
} from "#src/lifecycle/wait-subscription";
import { matchesShowWhen, type ShowWhen } from "#src/types/show-when";
import { parseTimeOfDayMinutes } from "#src/utils/wait-allowed-hours";
import { parseDurationMs, parsePositiveDurationMs } from "#src/utils/wait-time";
import type { WorkflowNode } from "#src/graph/types";
import { stepName, unlabelledStepName } from "#src/graph/step-name";

export type MissingRequiredField = {
  fieldKey: string;
  fieldLabel: string;
  /** Set when the field holds a value that cannot be read; absent when it is empty. */
  unreadable?: true | undefined;
};

/**
 * The sentence the editor's issue list and Publish both give for one field, so
 * the two never describe the same problem in different words. `nodeLabel` is
 * the step's own name, or undefined for a step that has none, and `number` its
 * number in the outline where the caller knows it.
 */
export function requiredFieldMessage(
  nodeLabel: string | undefined,
  field: MissingRequiredField,
  number?: number
): string {
  const step = stepName(nodeLabel, number);
  if (field.fieldKey === ACTION_TYPE_CONFIG_KEY && !field.unreadable) {
    return `${step} has no action chosen`;
  }
  return field.unreadable
    ? `${step} has a "${field.fieldLabel}" value that cannot be read`
    : `${step} is missing required field "${field.fieldLabel}"`;
}

/**
 * Whether a Wait's Duration holds text the engine cannot read as a duration. A
 * blank value is a missing field, and a template is read when the run reaches
 * the step, so neither counts.
 */
export function waitDurationCannotBeRead(value: unknown): boolean {
  return (
    typeof value === "string" &&
    !isBlank(value) &&
    findTemplateTokens(value).length === 0 &&
    parseDurationMs(value) === null
  );
}

export type MissingRequiredFieldInfo = {
  nodeId: string;
  /** What the step is called, falling back to what its card is titled. */
  nodeLabel: string;
  /** The step's own name, or undefined for a step with no label and no action. */
  stepLabel: string | undefined;
  missingFields: MissingRequiredField[];
};

type ActionConfigFieldBaseLike = {
  key: string;
  label: string;
  required?: boolean | undefined;
  showWhen?: ShowWhen | undefined;
  type?: string | undefined;
};

type ActionConfigFieldGroupLike = {
  type: "group";
  fields: readonly ActionConfigFieldBaseLike[];
};

type ActionConfigFieldLike =
  | ActionConfigFieldBaseLike
  | ActionConfigFieldGroupLike;

type ResolvedAction = {
  label?: string | undefined;
  configFields?: readonly ActionConfigFieldLike[] | undefined;
};

export type ResolveActionByType = (
  actionType: string
) => ResolvedAction | undefined;

function isFieldGroup(
  field: ActionConfigFieldLike
): field is ActionConfigFieldGroupLike {
  return (
    field.type === "group" && "fields" in field && Array.isArray(field.fields)
  );
}

function isFieldEmpty(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }

  if (typeof value === "string") {
    return isBlank(value);
  }

  return false;
}

function flattenConfigFields(
  fields: readonly ActionConfigFieldLike[]
): ActionConfigFieldBaseLike[] {
  const flattened: ActionConfigFieldBaseLike[] = [];

  for (const field of fields) {
    if (isFieldGroup(field)) {
      flattened.push(...field.fields);
      continue;
    }

    flattened.push(field);
  }

  return flattened;
}

function getPluginMissingRequiredFields(input: {
  config: Record<string, unknown>;
  configFields: readonly ActionConfigFieldLike[];
}): MissingRequiredField[] {
  const { config, configFields } = input;
  const flatFields = flattenConfigFields(configFields);

  return flatFields
    .filter(
      (field) =>
        field.required === true &&
        matchesShowWhen(config, field.showWhen) &&
        isFieldEmpty(config[field.key])
    )
    .map((field) => ({
      fieldKey: field.key,
      fieldLabel: field.label,
    }));
}

function getWaitMode(config: Record<string, unknown>): "delay" | "event" {
  return asNonEmptyString(config.waitMode) === "event" ? "event" : "delay";
}

function getWaitMissingRequiredFields(
  config: Record<string, unknown>
): MissingRequiredField[] {
  const waitMode = getWaitMode(config);

  if (waitMode === "event") {
    const eventMissing: MissingRequiredField[] = [];

    // An event-mode wait has to name at least one Event: the subscription index
    // the fan-out reads has no way to represent "any Event for this entity",
    // because a wildcard there is a subscription to every Event there is.
    if (readWaitSubscriptions(config).length === 0) {
      eventMissing.push({
        fieldKey: "waitFor",
        fieldLabel: "Wait for these events",
      });
    }

    // A match with a blank operand compares against the empty string, which no
    // arrival satisfies: the run would park until its timeout and nothing would
    // say why. The save rule lets that state through so a half-typed rule does
    // not refuse an autosave, which makes this the one place it is caught.
    for (const subscription of readWaitSubscriptions(config)) {
      const match = asNonEmptyString(subscription.match);
      if (!match) {
        continue;
      }

      const compiled = compileSerializedConditionModel(match);
      if (!compiled.valid && compiled.incomplete) {
        eventMissing.push({
          fieldKey: "waitFor",
          fieldLabel: `Match value for "${subscription.event}"`,
        });
      }
    }

    // A wait with no timeout is an immortal Execution, holding a row and a place
    // in the run list until somebody notices. The editor writes a default the
    // moment the mode is chosen, so a blank one here is a builder who cleared it.
    if (isFieldEmpty(config.waitTimeout)) {
      eventMissing.push({
        fieldKey: "waitTimeout",
        fieldLabel: WAIT_FIELD_LABELS.waitTimeout,
      });
    }

    return eventMissing;
  }

  const missing: MissingRequiredField[] = [];

  if (readWaitDelayTiming(config) === "until") {
    if (isFieldEmpty(config.waitUntil)) {
      missing.push({
        fieldKey: "waitUntil",
        fieldLabel: WAIT_FIELD_LABELS.waitUntil,
      });
    }
  } else if (isFieldEmpty(config.waitDuration)) {
    missing.push({
      fieldKey: "waitDuration",
      fieldLabel: WAIT_FIELD_LABELS.waitDuration,
    });
  } else if (waitDurationCannotBeRead(config.waitDuration)) {
    missing.push({
      fieldKey: "waitDuration",
      fieldLabel: WAIT_FIELD_LABELS.waitDuration,
      unreadable: true,
    });
  }

  if (asNonEmptyString(config.waitGateMode) === "max_lateness") {
    const maxLateness = asNonEmptyString(config.waitMaxLateness);
    if (
      !maxLateness ||
      (findTemplateTokens(maxLateness).length === 0 &&
        parsePositiveDurationMs(maxLateness) === null)
    ) {
      missing.push({
        fieldKey: "waitMaxLateness",
        fieldLabel: WAIT_FIELD_LABELS.waitMaxLateness,
      });
    }
  }

  if (asNonEmptyString(config.waitAllowedHoursMode) === "daily_window") {
    const startStr = asNonEmptyString(config.waitAllowedStartTime);
    if (!startStr || parseTimeOfDayMinutes(startStr) === null) {
      missing.push({
        fieldKey: "waitAllowedStartTime",
        fieldLabel: WAIT_FIELD_LABELS.waitAllowedStartTime,
      });
    }

    const endStr = asNonEmptyString(config.waitAllowedEndTime);
    if (!endStr || parseTimeOfDayMinutes(endStr) === null) {
      missing.push({
        fieldKey: "waitAllowedEndTime",
        fieldLabel: WAIT_FIELD_LABELS.waitAllowedEndTime,
      });
    }

    if (isFieldEmpty(config.waitTimezone)) {
      missing.push({
        fieldKey: "waitTimezone",
        fieldLabel: WAIT_FIELD_LABELS.waitTimezone,
      });
    }
  }

  return missing;
}

function getSystemMissingRequiredFields(input: {
  actionType: string;
  config: Record<string, unknown>;
}): MissingRequiredField[] {
  const { actionType, config } = input;

  switch (actionType) {
    case BUILT_IN_ACTION_IDS.condition: {
      return isFieldEmpty(config.condition)
        ? [
            {
              fieldKey: "condition",
              fieldLabel: "Condition",
            },
          ]
        : [];
    }
    case BUILT_IN_ACTION_IDS.wait:
      return getWaitMissingRequiredFields(config);
    default:
      return [];
  }
}

function getNodeLabel(input: {
  node: WorkflowNode;
  actionType?: string | undefined;
  actionLabel?: string | undefined;
}): string | undefined {
  const { node, actionType, actionLabel } = input;

  const explicitLabel = asNonEmptyString(node.data.label);
  if (explicitLabel) {
    return explicitLabel;
  }

  if (actionLabel) {
    return actionLabel;
  }

  return actionType;
}

export function getNodeMissingRequiredFields(input: {
  node: WorkflowNode;
  resolveActionByType: ResolveActionByType;
}): MissingRequiredFieldInfo | null {
  const { node, resolveActionByType } = input;

  if (node.data.type !== "action") {
    return null;
  }

  if (node.data.enabled === false) {
    return null;
  }

  const config = node.data.config ?? {};
  const actionType = asNonEmptyString(config.actionType);

  if (!actionType) {
    const stepLabel = getNodeLabel({ node });
    return {
      nodeId: node.id,
      nodeLabel: stepLabel ?? unlabelledStepName(node),
      stepLabel,
      missingFields: [
        {
          fieldKey: ACTION_TYPE_CONFIG_KEY,
          fieldLabel: "Action",
        },
      ],
    };
  }

  const action = resolveActionByType(actionType);
  const systemMissing = getSystemMissingRequiredFields({ actionType, config });
  const pluginMissing = action
    ? getPluginMissingRequiredFields({
        config,
        configFields: action.configFields ?? [],
      })
    : [];

  const missingFields = [...systemMissing, ...pluginMissing];

  if (missingFields.length === 0) {
    return null;
  }

  const stepLabel = getNodeLabel({
    node,
    actionType,
    actionLabel: action?.label,
  });
  return {
    nodeId: node.id,
    nodeLabel: stepLabel ?? unlabelledStepName(node),
    stepLabel,
    missingFields,
  };
}

export function getMissingRequiredFieldsForNodes(input: {
  nodes: WorkflowNode[];
  resolveActionByType: ResolveActionByType;
}): MissingRequiredFieldInfo[] {
  const { nodes, resolveActionByType } = input;

  return nodes
    .map((node) =>
      getNodeMissingRequiredFields({
        node,
        resolveActionByType,
      })
    )
    .filter((result): result is MissingRequiredFieldInfo => result !== null);
}
