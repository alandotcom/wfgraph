import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useState } from "react";
import {
  findAction,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import {
  fieldChangeCategory,
  isGroupFrameChange,
  isGroupMembershipPath,
  type WorkflowChangeCategory,
} from "@wfgraph/shared/graph/change-classification";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type {
  WorkflowComparisonPayload,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import { TEST_PAYLOADS_CONFIG_KEY } from "@wfgraph/shared/lifecycle/test-payloads";
import { compareText } from "@wfgraph/shared/types/string";
import { cn } from "@wfgraph/shared/utils";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import {
  type ComparisonConnection,
  comparisonFieldLabel,
  type ComparisonNode,
  ConditionValue,
  configFieldLabel,
  GENERIC_LABELS,
  groupConfigFieldLabel,
  groupMembershipTitle,
  isHiddenComparisonValue,
  readableValue,
  ValueNote,
} from "#src/components/workflow/comparison-field-labels";
import { ConditionSummary } from "#src/components/workflow/config/condition-summary";
import { PanelState } from "#src/components/workflow/workflow-changes-panel-state";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { comparisonSessionAtom } from "#src/lib/workflow-comparison-store";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import { comparisonNodeTitle } from "#src/lib/workflow-graph-types";

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
  /**
   * Whether the row is a Group organization change or a behavior change. Set
   * on each row of a modified node, since each of those rows is one field change.
   */
  category?: WorkflowChangeCategory | undefined;
};

/**
 * Which sides of a comparison hold values for an object: both for a modified
 * or unchanged object, the published version alone for a removed one, and the
 * draft alone for an added one.
 */
export type ComparisonSides = "both" | "before" | "after";

type ComparisonPayloadIndex = {
  baseNodes: ReadonlyMap<string, ComparisonNode>;
  draftNodes: ReadonlyMap<string, ComparisonNode>;
};

/** A string longer than this many characters is shown shortened until expanded. */
export const LONG_VALUE_LENGTH = 200;
/** A string with more lines than this is shown shortened until expanded. */
const LONG_VALUE_LINES = 4;

const payloadIndexes = new WeakMap<
  WorkflowComparisonPayload,
  ComparisonPayloadIndex
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
      .map(([key, raw]) =>
        node.data.type === "group"
          ? {
              key: `snapshot:config:${key}`,
              label: groupConfigFieldLabel([key]),
              ...value(["data", "config", key], raw),
            }
          : {
              key: `snapshot:config:${key}`,
              label: configFieldLabel(catalog, actionType, key),
              [side]: raw,
            }
      ),
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
 * when the change lists that path more than once. Each row of a modified node
 * carries its category, Organization or Behavior.
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
  const groupFrame = isGroupFrameChange({
    before: baseNode?.data.type,
    after: draftNode?.data.type,
  });
  return change.fields.map((field, position) => ({
    category: fieldChangeCategory({ path: field.path, groupFrame }),
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
 * The Group a modified step sits in on each side of `payload`, by title, or
 * null when `change` records no Group membership change. Each side's title is
 * read from that side's own graph, so a Group renamed in the draft keeps its
 * published title on the published side, as the step's field table shows it.
 */
export function comparisonGroupMembership(
  catalog: ExtensionCatalog,
  payload: WorkflowComparisonPayload,
  change: WorkflowNodeChange
): { before: string | null; after: string | null } | null {
  const field =
    change.kind === "modified"
      ? change.fields.find((item) => isGroupMembershipPath(item.path))
      : undefined;
  if (!field) return null;
  const index = payloadIndex(payload);
  return {
    before: groupMembershipTitle({
      catalog,
      groupId: field.before,
      nodes: index.baseNodes,
    }),
    after: groupMembershipTitle({
      catalog,
      groupId: field.after,
      nodes: index.draftNodes,
    }),
  };
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
