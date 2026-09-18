import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useState } from "react";
import {
  type ConditionModel,
  parseConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import {
  findAction,
  findEntity,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type {
  WorkflowComparisonPayload,
  WorkflowFieldChange,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import { TEST_PAYLOADS_CONFIG_KEY } from "@wfgraph/shared/lifecycle/test-payloads";
import { readLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import { compareText, isBlank } from "@wfgraph/shared/types/string";
import { cn } from "@wfgraph/shared/utils";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { ConditionSummary } from "#src/components/workflow/config/condition-summary";
import { eventLabel } from "#src/components/workflow/config/lifecycle-policy-summary";
import { CONCURRENCY_OPTIONS } from "#src/components/workflow/config/lifecycle-concurrency-group";
import { PanelState } from "#src/components/workflow/workflow-changes-panel-state";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import {
  type ConditionSelectableField,
  getEntityConditionFields,
  getEventConditionFields,
} from "#src/lib/upstream-node-fields";
import { comparisonSessionAtom } from "#src/lib/workflow-comparison-store";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import {
  comparisonNodeTitle,
  toEditorNode,
} from "#src/lib/workflow-graph-types";

/**
 * One property row of a comparison. `before` is the published version's value
 * and `after` the draft's; a side with no value for the property leaves its key
 * undefined.
 */
export type ComparisonField = {
  /** Machine-only identity for repeated generic labels in this list. */
  key: string;
  label: string;
  before?: unknown;
  after?: unknown;
};

/**
 * Which sides of a comparison hold values for an object: both for a modified
 * or unchanged object, the published version alone for a removed one, and the
 * draft alone for an added one.
 */
export type ComparisonSides = "both" | "before" | "after";

type ComparisonNode = ReturnType<typeof toWorkflowGraphData>["nodes"][number];
type ComparisonPayloadIndex = {
  baseNodes: ReadonlyMap<string, ComparisonNode>;
  draftNodes: ReadonlyMap<string, ComparisonNode>;
};

/** The label of a config value the step's action does not describe. */
const GENERIC_CONFIG_LABEL = "Configuration value";
/** The label of a node property outside `data` the editor has no name for. */
const GENERIC_PROPERTY_LABEL = "Property";
/** The label of a Lifecycle Rules value the editor has no name for. */
const GENERIC_LIFECYCLE_LABEL = "Lifecycle rule";
const GENERIC_LABELS: ReadonlySet<string> = new Set([
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
class ConditionValue {
  constructor(
    readonly model: ConditionModel,
    readonly fields: readonly ConditionSelectableField[],
    readonly setOperatorsRequireEnumValues: boolean
  ) {}
}

/** A sentence shown in place of a stored value that cannot be read as it is. */
class ValueNote {
  constructor(readonly text: string) {}
}

/** A connection the person has, by id, with the name it was given. */
export type ComparisonConnection = { id: string; name: string };

/** A string longer than this many characters is shown shortened until expanded. */
export const LONG_VALUE_LENGTH = 200;
/** A string with more lines than this is shown shortened until expanded. */
const LONG_VALUE_LINES = 4;

const NODE_TYPE_LABEL: Readonly<Record<string, string>> = {
  action: "Step",
  lifecycle: "Lifecycle",
  group: "Group",
  add: "Placeholder",
};

const payloadIndexes = new WeakMap<
  WorkflowComparisonPayload,
  ComparisonPayloadIndex
>();
const actionFieldLabels = new WeakMap<
  ExtensionCatalog,
  Map<string, Map<string, string>>
>();

function payloadIndex(
  payload: WorkflowComparisonPayload
): ComparisonPayloadIndex {
  const existing = payloadIndexes.get(payload);
  if (existing) return existing;
  const index = {
    baseNodes: new Map(
      toWorkflowGraphData(payload.baseGraph).nodes.map((node) => [
        node.id,
        node,
      ])
    ),
    draftNodes: new Map(
      toWorkflowGraphData(payload.draftGraph).nodes.map((node) => [
        node.id,
        node,
      ])
    ),
  };
  payloadIndexes.set(payload, index);
  return index;
}

function configFieldLabel(
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

export function comparisonFieldLabel(
  catalog: ExtensionCatalog,
  change: WorkflowFieldChange,
  beforeNode: ComparisonNode | undefined,
  afterNode: ComparisonNode | undefined
): string {
  const path = change.path;
  if (path.length === 1 && path[0] === "type") return "Type";
  if (path.length === 1 && path[0] === "parentId") return "Group";
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
 * The value a person reads for a property whose stored value is an identifier
 * or a serialized rule: a node type, an action id, a Group's node id, or a
 * Lifecycle Rules value. A value the server hid, and any other value, is
 * returned as it is. `node` and `nodes` are the node and the graph of the side
 * the value comes from.
 */
function readableValue(input: {
  catalog: ExtensionCatalog;
  path: readonly string[];
  value: unknown;
  node: ComparisonNode | undefined;
  nodes: ReadonlyMap<string, ComparisonNode>;
  connections: readonly ComparisonConnection[] | null;
}): unknown {
  const { catalog, path, value } = input;
  const joined = path.join(".");
  if (joined === "parentId") {
    if (typeof value !== "string") return "Not in a Group";
    const group = input.nodes.get(value);
    return group
      ? comparisonNodeTitle(group.data, catalog)
      : "Unavailable Group";
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

/** The plain text of a value that needs no expanding. */
export function formatComparisonValue(value: unknown): string {
  if (value === undefined) return "Not set";
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value))
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? "" : "s"}`;
}

/** Whether a string is long enough that it starts shortened. */
export function isLongComparisonValue(value: string): boolean {
  return (
    value.length > LONG_VALUE_LENGTH ||
    value.split("\n").length > LONG_VALUE_LINES
  );
}

/** The opening of a long string: its first lines, cut at `LONG_VALUE_LENGTH`. */
function shortenedValue(value: string): string {
  const lines = value.split("\n").slice(0, LONG_VALUE_LINES).join("\n");
  return `${lines.slice(0, LONG_VALUE_LENGTH).trimEnd()}…`;
}

function snapshotFields(
  catalog: ExtensionCatalog,
  node: ComparisonNode,
  nodes: ReadonlyMap<string, ComparisonNode>,
  side: "before" | "after"
): ComparisonField[] {
  const config = node.data.config ?? {};
  const actionType = config.actionType;
  const value = (path: readonly string[], raw: unknown) => ({
    [side]: readableValue({
      catalog,
      path,
      value: raw,
      node,
      nodes,
      connections: null,
    }),
  });
  const fields: ComparisonField[] = [
    {
      key: "snapshot:type",
      label: "Type",
      ...value(["data", "type"], node.data.type),
    },
    { key: "snapshot:label", label: "Label", [side]: node.data.label },
  ];
  if (node.parentId !== undefined)
    fields.push({
      key: "snapshot:group",
      label: "Group",
      ...value(["parentId"], node.parentId),
    });
  if (node.data.description !== undefined)
    fields.push({
      key: "snapshot:description",
      label: "Description",
      [side]: node.data.description,
    });
  if (node.data.enabled !== undefined)
    fields.push({
      key: "snapshot:enabled",
      label: "Enabled",
      [side]: node.data.enabled,
    });
  if (typeof actionType === "string")
    fields.push({
      label: "Action",
      key: "snapshot:action",
      ...value(["data", "config", "actionType"], actionType),
    });
  return [
    ...fields,
    ...Object.entries(config)
      // The server comparison leaves test payloads out of a workflow's meaning,
      // so an added or removed node lists the same config keys a modified one
      // can report.
      .filter(
        ([key]) => key !== "actionType" && key !== TEST_PAYLOADS_CONFIG_KEY
      )
      .toSorted(([left], [right]) => compareText(left, right))
      .map(([key, raw]) => ({
        key: `snapshot:config:${key}`,
        label: configFieldLabel(catalog, actionType, key),
        [side]: raw,
      })),
  ];
}

/**
 * The node `nodeId` as the published graph and the draft graph each hold it,
 * undefined on a side that does not hold it.
 */
export function comparisonNodeSnapshots(
  payload: WorkflowComparisonPayload,
  nodeId: string
): {
  baseNode: ComparisonNode | undefined;
  draftNode: ComparisonNode | undefined;
} {
  const index = payloadIndex(payload);
  return {
    baseNode: index.baseNodes.get(nodeId),
    draftNode: index.draftNodes.get(nodeId),
  };
}

/** The sides that hold values for a change of `kind`. */
export function comparisonSides(
  kind: WorkflowNodeChange["kind"] | "unchanged"
): ComparisonSides {
  return kind === "added" ? "after" : kind === "removed" ? "before" : "both";
}

/**
 * The property rows for a node change. An added node lists the draft's values
 * and a removed node the published values, each from its snapshot. A modified
 * node lists each changed property with both values. Identifiers read as names,
 * and a Connection id reads as a name from `options.connections` when that
 * list holds it. A row's key is its path, and the path plus its position only
 * when the change lists that path more than once.
 */
export function comparisonFields(
  catalog: ExtensionCatalog,
  payload: WorkflowComparisonPayload,
  change: WorkflowNodeChange,
  options?: { connections?: readonly ComparisonConnection[] | undefined }
): ComparisonField[] {
  const connections = options?.connections ?? null;
  const index = payloadIndex(payload);
  const { baseNode, draftNode } = comparisonNodeSnapshots(
    payload,
    change.nodeId
  );
  if (change.kind === "added" && draftNode)
    return snapshotFields(catalog, draftNode, index.draftNodes, "after");
  if (change.kind === "removed" && baseNode)
    return snapshotFields(catalog, baseNode, index.baseNodes, "before");
  const pathKeys = change.fields.map((field) => JSON.stringify(field.path));
  const pathsUnique = new Set(pathKeys).size === pathKeys.length;
  return change.fields.map((field, position) => ({
    key: pathsUnique
      ? `field:${pathKeys[position]}`
      : `field:${pathKeys[position]}:${position}`,
    label: comparisonFieldLabel(catalog, field, baseNode, draftNode),
    before: readableValue({
      catalog,
      path: field.path,
      value: field.before,
      node: baseNode,
      nodes: index.baseNodes,
      connections,
    }),
    after: readableValue({
      catalog,
      path: field.path,
      value: field.after,
      node: draftNode,
      nodes: index.draftNodes,
      connections,
    }),
  }));
}

/**
 * Whether the comparison holds the values a change needs: the draft's node for
 * an added node, the published node for a removed one, and either node or a
 * recorded property change for a modified one.
 */
export function comparisonValuesAvailable(
  payload: WorkflowComparisonPayload,
  change: WorkflowNodeChange
): boolean {
  const { baseNode, draftNode } = comparisonNodeSnapshots(
    payload,
    change.nodeId
  );
  if (change.kind === "added") return draftNode !== undefined;
  if (change.kind === "removed") return baseNode !== undefined;
  return (
    baseNode !== undefined ||
    draftNode !== undefined ||
    change.fields.length > 0
  );
}

/**
 * Why some property names of a node change are general ones, or null when every
 * name is known: the node's action is missing from the extension catalog, the
 * action no longer describes some of the stored settings, or a Lifecycle Rules
 * value has no name in this editor.
 */
export function comparisonMetadataNotice(input: {
  catalog: ExtensionCatalog;
  payload: WorkflowComparisonPayload;
  change: WorkflowNodeChange;
  fields: readonly ComparisonField[];
}): string | null {
  const { baseNode, draftNode } = comparisonNodeSnapshots(
    input.payload,
    input.change.nodeId
  );
  const node = input.change.kind === "removed" ? baseNode : draftNode;
  const actionType = (node ?? baseNode ?? draftNode)?.data.config?.actionType;
  if (
    typeof actionType === "string" &&
    findAction(input.catalog, actionType) === undefined
  ) {
    return input.change.kind === "removed"
      ? "The action this step used is not available in this editor, so its settings show general names."
      : "The action this step uses is not available in this editor, so its settings show general names.";
  }
  if (!input.fields.some((field) => GENERIC_LABELS.has(field.label))) {
    return null;
  }
  return (node ?? baseNode ?? draftNode)?.data.type === "lifecycle"
    ? "Some Lifecycle settings have no name in this editor, so they show general names."
    : "Some settings are not described by this step's action, so they show general names.";
}

/**
 * The title of the node a change names, read from the published graph for a
 * removed node and from the draft for any other.
 */
export function changedNodeTitle(
  catalog: ExtensionCatalog,
  payload: WorkflowComparisonPayload,
  change: WorkflowNodeChange
): string {
  const { baseNode, draftNode } = comparisonNodeSnapshots(
    payload,
    change.nodeId
  );
  const node = change.kind === "removed" ? baseNode : draftNode;
  return node ? comparisonNodeTitle(node.data, catalog) : "Unavailable action";
}

/**
 * One comparison value. A missing value reads "Not set", a value the server
 * redacted or masked reads "Hidden for security", a stored condition reads as
 * sentences, and a long string starts shortened with a control that shows all
 * of it. The expanded state lives in this component, so keying it resets it.
 */
export function ComparisonValue({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  if (value === undefined) {
    return <span className="text-muted-foreground">Not set</span>;
  }
  if (isHiddenComparisonValue(value)) {
    return (
      <span className="text-muted-foreground" data-state="hidden">
        Hidden for security
      </span>
    );
  }
  if (value instanceof ValueNote) {
    return (
      <span className="text-muted-foreground" data-state="unreadable">
        {value.text}
      </span>
    );
  }
  if (value instanceof ConditionValue) {
    return (
      <ConditionSummary
        compact
        fields={value.fields}
        model={value.model}
        setOperatorsRequireEnumValues={value.setOperatorsRequireEnumValues}
      />
    );
  }
  if (typeof value !== "string" || !isLongComparisonValue(value)) {
    return (
      <span className="whitespace-pre-wrap">
        {formatComparisonValue(value)}
      </span>
    );
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="whitespace-pre-wrap" data-slot="comparison-long-value">
        {expanded ? value : shortenedValue(value)}
      </span>
      <span className="text-muted-foreground">
        Long value, {value.length.toLocaleString()} characters
      </span>
      <Button
        aria-expanded={expanded}
        className="h-auto px-0 text-xs"
        onClick={() => setExpanded(!expanded)}
        size="sm"
        type="button"
        variant="link"
      >
        {expanded ? "Show less" : "Show full value"}
      </Button>
    </span>
  );
}

/**
 * The connections the query cache already holds, or undefined when it holds
 * none. It never requests the list, so a comparison names a Connection only
 * when another surface has loaded it.
 */
export function useCachedConnections():
  | readonly ComparisonConnection[]
  | undefined {
  return useQuery({ ...integrationsQueryOptions(), enabled: false }).data;
}

/**
 * Property rows as a table: a row per property, with a column for each side
 * `sides` names, headed `beforeLabel` and `afterLabel`.
 */
export function ComparisonFieldTable({
  fields,
  sides,
  beforeLabel,
  afterLabel,
  caption,
}: {
  fields: readonly ComparisonField[];
  sides: ComparisonSides;
  beforeLabel: string;
  afterLabel: string;
  /** The table's accessible name. */
  caption: string;
}) {
  const showsBefore = sides !== "after";
  const showsAfter = sides !== "before";
  const cell = "min-w-0 px-2 py-1.5 align-top break-words";
  return (
    <table className="w-full table-fixed border-collapse text-xs">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="text-left text-muted-foreground">
          <th
            className={cn(
              cell,
              "font-medium",
              sides === "both" ? "w-1/4" : "w-1/3"
            )}
            scope="col"
          >
            Setting
          </th>
          {showsBefore ? (
            <th className={cn(cell, "font-medium")} scope="col">
              {beforeLabel}
            </th>
          ) : null}
          {showsAfter ? (
            <th className={cn(cell, "font-medium")} scope="col">
              {afterLabel}
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <tr className="border-t" key={field.key}>
            <th
              className={cn(
                cell,
                "text-left font-medium text-muted-foreground"
              )}
              scope="row"
            >
              {field.label}
            </th>
            {showsBefore ? (
              <td className={cell}>
                <ComparisonValue value={field.before} />
              </td>
            ) : null}
            {showsAfter ? (
              <td className={cell}>
                <ComparisonValue value={field.after} />
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ComparisonProperties({
  catalog,
  change,
  payload,
}: {
  catalog: ExtensionCatalog;
  change: WorkflowNodeChange;
  payload: WorkflowComparisonPayload;
}) {
  const connections = useCachedConnections();
  const fields = comparisonFields(catalog, payload, change, { connections });
  return (
    <section className="border-t p-4" data-testid="comparison-properties">
      <h3 className="font-medium text-sm">
        {changedNodeTitle(catalog, payload, change)}
      </h3>
      <p className="mt-1 text-muted-foreground text-xs">
        {change.kind === "modified"
          ? "Published and current draft values"
          : change.kind === "added"
            ? "Current draft values"
            : "Published values"}
      </p>
      <div className="mt-3">
        <ComparisonFieldTable
          afterLabel="Current draft"
          beforeLabel="Published"
          caption="Changed settings"
          fields={fields}
          sides={comparisonSides(change.kind)}
        />
      </div>
    </section>
  );
}

/** Read-only Properties content for a node selected from an active comparison. */
export function WorkflowComparisonPropertiesPanel() {
  const catalog = useExtensionCatalog();
  const session = useAtomValue(comparisonSessionAtom);
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const change = session?.payload.nodeChanges.find(
    (candidate) => candidate.nodeId === selectedNodeId
  );

  if (!(session && change)) {
    return <PanelState label="Select a changed step to inspect its values." />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable_both-edges]">
      <ComparisonProperties
        catalog={catalog}
        change={change}
        payload={session.payload}
      />
    </div>
  );
}
