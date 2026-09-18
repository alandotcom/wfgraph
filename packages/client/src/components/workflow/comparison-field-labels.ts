/**
 * How a comparison names a changed field and reads its stored values. A label
 * comes from the extension catalog, the Lifecycle Rules, or the Group frame the
 * field belongs to, and an identifier or serialized rule reads as a name or as
 * sentences. Nothing here renders.
 */

import {
  type ConditionModel,
  parseConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import {
  findAction,
  findEntity,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { isGroupMembershipPath } from "@wfgraph/shared/graph/change-classification";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type { WorkflowFieldChange } from "@wfgraph/shared/graph/publication-contracts";
import { readLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import { isBlank } from "@wfgraph/shared/types/string";
import { eventLabel } from "#src/components/workflow/config/lifecycle-policy-summary";
import { CONCURRENCY_OPTIONS } from "#src/components/workflow/config/lifecycle-concurrency-group";
import {
  type ConditionSelectableField,
  getEntityConditionFields,
  getEventConditionFields,
} from "#src/lib/upstream-node-fields";
import {
  comparisonNodeTitle,
  toEditorNode,
} from "#src/lib/workflow-graph-types";

/** A node of a comparison graph, as the published or draft side holds it. */
export type ComparisonNode = ReturnType<
  typeof toWorkflowGraphData
>["nodes"][number];

/** The label of a config value the step's action does not describe. */
const GENERIC_CONFIG_LABEL = "Configuration value";
/** The label of a node property outside `data` the editor has no name for. */
const GENERIC_PROPERTY_LABEL = "Property";
/** The label of a Lifecycle Rules value the editor has no name for. */
const GENERIC_LIFECYCLE_LABEL = "Lifecycle rule";
export const GENERIC_LABELS: ReadonlySet<string> = new Set([
  GENERIC_CONFIG_LABEL,
  GENERIC_PROPERTY_LABEL,
  GENERIC_LIFECYCLE_LABEL,
]);

/** The text the server's redactor puts in place of a sensitive value. */
const REDACTED_TEXT = "[REDACTED]";
/**
 * A sensitive string as the server's `maskValue` masks it: four stars for a
 * string of four characters or fewer, and otherwise one to eight stars followed
 * by the string's last four characters.
 */
const MASKED_VALUE = /^(?:\*{4}|\*{1,8}[\s\S]{4})$/;

/** Whether a comparison value is one the server redacted before sending it. */
export function isHiddenComparisonValue(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value.includes(REDACTED_TEXT) || MASKED_VALUE.test(value))
  );
}

/**
 * A stored condition shown as sentences. `fields` names what its rules read,
 * and `setOperatorsRequireEnumValues` is set for Entity eligibility.
 */
export class ConditionValue {
  constructor(
    readonly model: ConditionModel,
    readonly fields: readonly ConditionSelectableField[],
    readonly setOperatorsRequireEnumValues: boolean
  ) {}
}

/** A sentence shown in place of a stored value that cannot be read as it is. */
export class ValueNote {
  constructor(readonly text: string) {}
}

/** A connection the person has, by id, with the name it was given. */
export type ComparisonConnection = { id: string; name: string };

const NODE_TYPE_LABEL: Readonly<Record<string, string>> = {
  action: "Step",
  lifecycle: "Lifecycle",
  group: "Group",
  add: "Placeholder",
};

const actionFieldLabels = new WeakMap<
  ExtensionCatalog,
  Map<string, Map<string, string>>
>();

export function configFieldLabel(
  catalog: ExtensionCatalog,
  actionType: unknown,
  key: string
): string {
  if (typeof actionType !== "string") return GENERIC_CONFIG_LABEL;
  let catalogLabels = actionFieldLabels.get(catalog);
  if (!catalogLabels) {
    catalogLabels = new Map();
    actionFieldLabels.set(catalog, catalogLabels);
  }
  let labels = catalogLabels.get(actionType);
  if (!labels) {
    const action = findAction(catalog, actionType);
    labels = new Map(
      (action ? flattenConfigFields(action.configFields) : []).map((field) => [
        field.key,
        field.label,
      ])
    );
    catalogLabels.set(actionType, labels);
  }
  return labels.get(key) ?? GENERIC_CONFIG_LABEL;
}

function titleFromPath(path: string): string {
  const key =
    path
      .split(".")
      .at(-1)
      ?.replace(/\[\d+\]$/g, "") ?? "Value";
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * The part of a config path below its config key, as "Item 2 › Name": a list
 * index counts from one and a key reads as words.
 */
function nestedPathLabel(segments: readonly string[]): string {
  return segments
    .map((segment) =>
      /^\d+$/.test(segment)
        ? `Item ${Number(segment) + 1}`
        : titleFromPath(segment)
    )
    .join(" › ");
}

/** The name of each Lifecycle Rules key whose values are not keyed by Event. */
const LIFECYCLE_RULE_LABELS: Readonly<Record<string, string>> = {
  startEvents: "Start events",
  cancelEvents: "Cancel events",
  concurrency: "Concurrency",
  allowManualStart: "Manual runs",
};

/** The name of each Lifecycle Rules record keyed by Event name. */
const LIFECYCLE_EVENT_RECORD_LABELS: Readonly<Record<string, string>> = {
  correlationPaths: "Correlation path",
  connectionIds: "Connection",
  startFilters: "Start filter",
  cancelFilters: "Cancel filter",
};

/** The words each Entity eligibility checkpoint reads as. */
const ELIGIBILITY_CHECKPOINT_LABELS: Readonly<Record<string, string>> = {
  "before-execution": "Before starting",
  "before-node": "Before each step",
};

/**
 * The label of a value inside Lifecycle Rules, where `rulePath` is the path
 * below `lifecycleRules`. A value keyed by Event name carries that Event's
 * catalog label, as "Start filter › Appointment booked".
 */
function lifecycleRuleLabel(
  catalog: ExtensionCatalog,
  rulePath: readonly string[]
): string {
  const [ruleKey = "", second, third] = rulePath;
  const eventRecordLabel = LIFECYCLE_EVENT_RECORD_LABELS[ruleKey];
  if (eventRecordLabel !== undefined) {
    return second === undefined
      ? eventRecordLabel
      : `${eventRecordLabel} › ${eventLabel(catalog, second)}`;
  }
  if (ruleKey === "trackedEntity") {
    if (second === "type" || second === undefined) return "Tracked Entity";
    if (second === "bindings") {
      return third === undefined
        ? "Tracked Entity in each Event"
        : `Tracked Entity › ${eventLabel(catalog, third)}`;
    }
    return GENERIC_LIFECYCLE_LABEL;
  }
  if (ruleKey === "entityEligibility") {
    if (second === "condition") return "Eligible when";
    if (second === "checkpoints") return "Eligibility checked";
    return second === undefined
      ? "Entity eligibility"
      : GENERIC_LIFECYCLE_LABEL;
  }
  return LIFECYCLE_RULE_LABELS[ruleKey] ?? GENERIC_LIFECYCLE_LABEL;
}

function lifecycleConfigFieldLabel(
  catalog: ExtensionCatalog,
  path: readonly string[]
): string {
  const configKey = path[2];
  if (configKey === "lifecycleRules") {
    return lifecycleRuleLabel(catalog, path.slice(3));
  }
  return GENERIC_CONFIG_LABEL;
}

/** The label of a Group frame's config value at `configPath`, below `config`. */
export function groupConfigFieldLabel(_configPath: readonly string[]): string {
  return GENERIC_CONFIG_LABEL;
}

export function comparisonFieldLabel(
  catalog: ExtensionCatalog,
  change: WorkflowFieldChange,
  beforeNode: ComparisonNode | undefined,
  afterNode: ComparisonNode | undefined
): string {
  const path = change.path;
  if (path.length === 1 && path[0] === "type") return "Type";
  if (isGroupMembershipPath(path)) return "Group";
  if (path[0] !== "data") return GENERIC_PROPERTY_LABEL;
  const key = path[1];
  if (key === "type") return "Type";
  if (key === "label") return "Label";
  if (key === "description") return "Description";
  if (key === "enabled") return "Enabled";
  if (key !== "config") return GENERIC_PROPERTY_LABEL;
  const configKey = path[2];
  if (configKey === "actionType") return "Action";
  const node = afterNode ?? beforeNode;
  if (node?.data.type === "group") {
    return groupConfigFieldLabel(path.slice(2));
  }
  if (node?.data.type === "lifecycle") {
    return lifecycleConfigFieldLabel(catalog, path);
  }
  const label = configFieldLabel(
    catalog,
    afterNode?.data.config?.actionType ?? beforeNode?.data.config?.actionType,
    configKey ?? "value"
  );
  return path.length > 3 && label !== GENERIC_CONFIG_LABEL
    ? `${label} › ${nestedPathLabel(path.slice(3))}`
    : label;
}

/**
 * A stored condition model as sentences reading `fields`, a note when the
 * model does not decode, and undefined when nothing is stored.
 */
function readableCondition(
  stored: string,
  fields: () => readonly ConditionSelectableField[],
  setOperatorsRequireEnumValues: boolean
): ConditionValue | ValueNote | undefined {
  if (isBlank(stored)) return undefined;
  const parsed = parseConditionModel(stored);
  return parsed.valid
    ? new ConditionValue(parsed.model, fields(), setOperatorsRequireEnumValues)
    : new ValueNote("Filter changed");
}

/**
 * The value a person reads for a string inside Lifecycle Rules, where
 * `rulePath` is the path below `lifecycleRules` and `node` is the Lifecycle
 * Node on the side the value comes from.
 */
function readableLifecycleValue(input: {
  catalog: ExtensionCatalog;
  rulePath: readonly string[];
  value: string;
  node: ComparisonNode | undefined;
  nodes: ReadonlyMap<string, ComparisonNode>;
  connections: readonly ComparisonConnection[] | null;
}): unknown {
  const { catalog, value } = input;
  const [ruleKey, second, third] = input.rulePath;
  switch (ruleKey) {
    case "startEvents":
    case "cancelEvents":
      return eventLabel(catalog, value);
    case "concurrency":
      return (
        CONCURRENCY_OPTIONS.find((option) => option.value === value)?.label ??
        value
      );
    case "startFilters":
    case "cancelFilters":
      return second === undefined
        ? value
        : readableCondition(
            value,
            () =>
              getEventConditionFields(
                catalog,
                second,
                [...input.nodes.values()].map(toEditorNode)
              ),
            false
          );
    case "connectionIds": {
      const name = input.connections?.find(
        (connection) => connection.id === value
      )?.name;
      return name === undefined || isBlank(name)
        ? new ValueNote("Connection changed")
        : name;
    }
    case "trackedEntity":
      return second === "type"
        ? (findEntity(catalog, value)?.label ?? value)
        : value;
    case "entityEligibility": {
      if (second === "checkpoints" && third !== undefined) {
        return ELIGIBILITY_CHECKPOINT_LABELS[value] ?? value;
      }
      if (second !== "condition") return value;
      const entityType = readLifecycleRules(input.node?.data.config)
        ?.trackedEntity?.type;
      return readableCondition(
        value,
        () =>
          entityType === undefined
            ? []
            : getEntityConditionFields(catalog, entityType),
        true
      );
    }
    default:
      return value;
  }
}

/**
 * The title of the Group a step's stored `parentId` value `groupId` names,
 * looked up in `nodes`, the graph of the side the value comes from. Answers
 * null when the value names no Group, and "Unavailable Group" when that graph
 * does not hold the Group.
 */
export function groupMembershipTitle(input: {
  catalog: ExtensionCatalog;
  groupId: unknown;
  nodes: ReadonlyMap<string, ComparisonNode>;
}): string | null {
  if (typeof input.groupId !== "string") return null;
  const group = input.nodes.get(input.groupId);
  return group
    ? comparisonNodeTitle(group.data, input.catalog)
    : "Unavailable Group";
}

/**
 * The value a person reads for a property whose stored value is an identifier
 * or a serialized rule: a node type, an action id, a Group's node id, a
 * or a Lifecycle Rules value. A value the server hid, and any other value, is
 * returned as it is. `node` and `nodes` are the node and the graph of the side
 * the value comes from.
 */
export function readableValue(input: {
  catalog: ExtensionCatalog;
  path: readonly string[];
  value: unknown;
  node: ComparisonNode | undefined;
  nodes: ReadonlyMap<string, ComparisonNode>;
  connections: readonly ComparisonConnection[] | null;
}): unknown {
  const { catalog, path, value } = input;
  const joined = path.join(".");
  if (isGroupMembershipPath(path)) {
    return (
      groupMembershipTitle({ catalog, groupId: value, nodes: input.nodes }) ??
      "Not in a Group"
    );
  }
  if (typeof value !== "string" || isHiddenComparisonValue(value)) {
    return value;
  }
  if (joined === "type" || joined === "data.type") {
    return NODE_TYPE_LABEL[value] ?? value;
  }
  if (joined === "data.config.actionType") {
    return findAction(catalog, value)?.label ?? "Unavailable action";
  }
  if (path[2] === "lifecycleRules") {
    return readableLifecycleValue({
      ...input,
      rulePath: path.slice(3),
      value,
    });
  }
  return value;
}
