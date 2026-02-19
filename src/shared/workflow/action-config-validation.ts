import type { WorkflowNode } from "@/shared/workflow/types";

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
  fields: ActionConfigFieldBaseLike[];
};

type ActionConfigFieldLike =
  | ActionConfigFieldBaseLike
  | ActionConfigFieldGroupLike;

type ResolvedAction = {
  label?: string;
  configFields?: ActionConfigFieldLike[];
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

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  fields: ActionConfigFieldLike[]
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
  configFields: ActionConfigFieldLike[];
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

function getWaitMode(config: Record<string, unknown>): "delay" | "hook" {
  return asNonEmptyString(config.waitMode) === "hook" ? "hook" : "delay";
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
    case "Wait": {
      if (getWaitMode(config) === "hook") {
        return [];
      }

      if (getDelayTimingMode(config) === "until") {
        return isFieldEmpty(config.waitUntil)
          ? [
              {
                fieldKey: "waitUntil",
                fieldLabel: "Wait until this date/time",
              },
            ]
          : [];
      }

      return isFieldEmpty(config.waitDuration)
        ? [
            {
              fieldKey: "waitDuration",
              fieldLabel: "Wait for (duration)",
            },
          ]
        : [];
    }
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

function isActionConfig(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  const config = isActionConfig(node.data.config) ? node.data.config : {};
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
