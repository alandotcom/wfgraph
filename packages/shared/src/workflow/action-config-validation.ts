import { asNonEmptyString } from "#src/types/string";
import { readWaitSubscriptions } from "#src/workflow/wait-subscription";
import { parseTimeOfDayMinutes } from "#src/utils/wait-allowed-hours";
import type { WorkflowNode } from "#src/workflow/types";

export type MissingRequiredField = {
  fieldKey: string;
  fieldLabel: string;
};

export type MissingRequiredFieldInfo = {
  nodeId: string;
  nodeLabel: string;
  missingFields: MissingRequiredField[];
};

type ActionConfigFieldBaseLike = {
  key: string;
  label: string;
  required?: boolean;
  showWhen?: {
    field: string;
    equals: string;
  };
  type?: string;
};

type ActionConfigFieldGroupLike = {
  type: "group";
  fields: readonly ActionConfigFieldBaseLike[];
};

type ActionConfigFieldLike =
  | ActionConfigFieldBaseLike
  | ActionConfigFieldGroupLike;

type ResolvedAction = {
  label?: string;
  configFields?: readonly ActionConfigFieldLike[];
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
    return value.trim().length === 0;
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

function shouldShowField(
  field: ActionConfigFieldBaseLike,
  config: Record<string, unknown>
): boolean {
  if (!field.showWhen) {
    return true;
  }

  return config[field.showWhen.field] === field.showWhen.equals;
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
        shouldShowField(field, config) &&
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

function getDelayTimingMode(
  config: Record<string, unknown>
): "duration" | "until" {
  const mode = asNonEmptyString(config.waitDelayTimingMode);

  if (mode === "until") {
    return "until";
  }

  if (mode === "duration") {
    return "duration";
  }

  const hasWaitUntil = !isFieldEmpty(config.waitUntil);
  return hasWaitUntil ? "until" : "duration";
}

function getWaitMissingRequiredFields(
  config: Record<string, unknown>
): MissingRequiredField[] {
  const waitMode = getWaitMode(config);

  if (waitMode === "event") {
    const eventMissing: MissingRequiredField[] = [];

    // An event-mode wait has to name at least one Event. An empty list used to
    // mean "any Event for this entity", and the subscription index the fan-out
    // reads has no way to hold that: a wildcard is a subscription to every Event
    // there is.
    if (readWaitSubscriptions(config).length === 0) {
      eventMissing.push({
        fieldKey: "waitFor",
        fieldLabel: "Wait for these events",
      });
    }

    // A wait with no timeout is an immortal Execution, holding a row and a place
    // in the run list until somebody notices. The editor writes a default the
    // moment the mode is chosen, so a blank one here is a builder who cleared it.
    if (isFieldEmpty(config.waitTimeout)) {
      eventMissing.push({
        fieldKey: "waitTimeout",
        fieldLabel: "Stop waiting after",
      });
    }

    return eventMissing;
  }

  const missing: MissingRequiredField[] = [];

  if (getDelayTimingMode(config) === "until") {
    if (isFieldEmpty(config.waitUntil)) {
      missing.push({
        fieldKey: "waitUntil",
        fieldLabel: "Wait until this date/time",
      });
    }
  } else if (isFieldEmpty(config.waitDuration)) {
    missing.push({
      fieldKey: "waitDuration",
      fieldLabel: "Wait for (duration)",
    });
  }

  if (asNonEmptyString(config.waitAllowedHoursMode) === "daily_window") {
    const startStr = asNonEmptyString(config.waitAllowedStartTime);
    if (!startStr || parseTimeOfDayMinutes(startStr) === null) {
      missing.push({
        fieldKey: "waitAllowedStartTime",
        fieldLabel: "Window start (HH:MM)",
      });
    }

    const endStr = asNonEmptyString(config.waitAllowedEndTime);
    if (!endStr || parseTimeOfDayMinutes(endStr) === null) {
      missing.push({
        fieldKey: "waitAllowedEndTime",
        fieldLabel: "Window end (HH:MM)",
      });
    }

    if (isFieldEmpty(config.waitTimezone)) {
      missing.push({
        fieldKey: "waitTimezone",
        fieldLabel: "Timezone",
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
    case "HTTP Request": {
      return isFieldEmpty(config.endpoint)
        ? [
            {
              fieldKey: "endpoint",
              fieldLabel: "URL",
            },
          ]
        : [];
    }
    case "Database Query": {
      const hasDbQuery = !isFieldEmpty(config.dbQuery);
      const hasLegacyQuery = !isFieldEmpty(config.query);

      return hasDbQuery || hasLegacyQuery
        ? []
        : [
            {
              fieldKey: "dbQuery",
              fieldLabel: "SQL Query",
            },
          ];
    }
    case "Condition": {
      return isFieldEmpty(config.condition)
        ? [
            {
              fieldKey: "condition",
              fieldLabel: "Condition",
            },
          ]
        : [];
    }
    case "Wait":
      return getWaitMissingRequiredFields(config);
    default:
      return [];
  }
}

function getNodeLabel(input: {
  node: WorkflowNode;
  actionType?: string;
  actionLabel?: string;
}): string {
  const { node, actionType, actionLabel } = input;

  const explicitLabel = asNonEmptyString(node.data.label);
  if (explicitLabel) {
    return explicitLabel;
  }

  if (actionLabel) {
    return actionLabel;
  }

  if (actionType) {
    return actionType;
  }

  return node.id;
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
    return {
      nodeId: node.id,
      nodeLabel: getNodeLabel({ node }),
      missingFields: [
        {
          fieldKey: "actionType",
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

  return {
    nodeId: node.id,
    nodeLabel: getNodeLabel({
      node,
      actionType,
      actionLabel: action?.label,
    }),
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
