import { useAtomValue } from "jotai";
import {
  findAction,
  findEvent,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type {
  WorkflowComparisonPayload,
  WorkflowFieldChange,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { PanelState } from "#src/components/workflow/workflow-changes-panel-state";
import { comparisonSessionAtom } from "#src/lib/workflow-comparison-store";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import { comparisonNodeTitle as comparisonGraphNodeTitle } from "#src/lib/workflow-graph-types";

export type ComparisonField = {
  /** Machine-only identity for repeated generic labels in this list. */
  key: string;
  label: string;
  before?: unknown;
  after?: unknown;
};
type ComparisonNode = ReturnType<typeof toWorkflowGraphData>["nodes"][number];
type ComparisonPayloadIndex = {
  baseNodes: ReadonlyMap<string, ComparisonNode>;
  draftNodes: ReadonlyMap<string, ComparisonNode>;
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
  if (typeof actionType !== "string") return "Configuration value";
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
  return labels.get(key) ?? "Configuration value";
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

function lifecycleConfigFieldLabel(
  catalog: ExtensionCatalog,
  path: readonly string[]
): string {
  const configKey = path[2];
  if (configKey === "lifecycleRules") {
    const labels: Record<string, string> = {
      startEvents: "Start events",
      cancelEvents: "Cancel events",
      concurrency: "Concurrency",
      allowManualStart: "Manual runs",
      correlationPaths: "Correlation path",
      connectionIds: "Connection",
      startFilters: "Start filter",
    };
    return labels[path[3] ?? ""] ?? "Lifecycle rule";
  }
  if (configKey !== "testPayloads") {
    return "Configuration value";
  }

  const payloadKind = path[3];
  const eventName = payloadKind === "byEvent" ? path[4] : undefined;
  const payloadPath = path
    .slice(eventName ? 5 : 4)
    .filter((segment) => !/^\d+$/.test(segment))
    .join(".");
  if (!payloadPath) {
    return "Test payload";
  }

  const field = eventName
    ? findEvent(catalog, eventName)?.payloadFields.find(
        (candidate) => candidate.path === payloadPath
      )
    : undefined;
  return field?.description?.trim() || titleFromPath(payloadPath);
}

export function comparisonFieldLabel(
  catalog: ExtensionCatalog,
  change: WorkflowFieldChange,
  beforeNode: ComparisonNode | undefined,
  afterNode: ComparisonNode | undefined
): string {
  const path = change.path;
  if (path.length === 1 && path[0] === "type") return "Type";
  if (path.length === 1 && path[0] === "parentId") return "Connection";
  if (path[0] !== "data") return "Property";
  const key = path[1];
  if (key === "type") return "Type";
  if (key === "label") return "Label";
  if (key === "description") return "Description";
  if (key === "enabled") return "Enabled";
  if (key !== "config") return "Property";
  const configKey = path[2];
  if (configKey === "actionType") return "Action";
  const node = afterNode ?? beforeNode;
  if (node?.data.type === "lifecycle") {
    return lifecycleConfigFieldLabel(catalog, path);
  }
  return configFieldLabel(
    catalog,
    afterNode?.data.config?.actionType ?? beforeNode?.data.config?.actionType,
    configKey ?? "value"
  );
}

export function formatComparisonValue(value: unknown): string {
  if (value === undefined) return "Not present";
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value))
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? "" : "s"}`;
}

function snapshotFields(
  catalog: ExtensionCatalog,
  node: ComparisonNode
): ComparisonField[] {
  const config = node.data.config ?? {};
  const actionType = config.actionType;
  const fields: ComparisonField[] = [
    { key: "snapshot:type", label: "Type", after: node.data.type },
    { key: "snapshot:label", label: "Label", after: node.data.label },
  ];
  if (node.data.description !== undefined)
    fields.push({
      key: "snapshot:description",
      label: "Description",
      after: node.data.description,
    });
  if (node.data.enabled !== undefined)
    fields.push({
      key: "snapshot:enabled",
      label: "Enabled",
      after: node.data.enabled,
    });
  if (typeof actionType === "string")
    fields.push({
      label: "Action",
      key: "snapshot:action",
      after: findAction(catalog, actionType)?.label ?? "Unavailable action",
    });
  return [
    ...fields,
    ...Object.entries(config)
      .filter(([key]) => key !== "actionType")
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key: `snapshot:config:${key}`,
        label: configFieldLabel(catalog, actionType, key),
        after: value,
      })),
  ];
}

function nodeSnapshots(payload: WorkflowComparisonPayload, nodeId: string) {
  const index = payloadIndex(payload);
  return {
    baseNode: index.baseNodes.get(nodeId),
    draftNode: index.draftNodes.get(nodeId),
  };
}

export function comparisonFields(
  catalog: ExtensionCatalog,
  payload: WorkflowComparisonPayload,
  change: WorkflowNodeChange
): ComparisonField[] {
  const { baseNode, draftNode } = nodeSnapshots(payload, change.nodeId);
  if (change.kind === "added" && draftNode)
    return snapshotFields(catalog, draftNode);
  if (change.kind === "removed" && baseNode)
    return snapshotFields(catalog, baseNode);
  return change.fields.map((field, index) => ({
    key: `field:${JSON.stringify(field.path)}:${index}`,
    label: comparisonFieldLabel(catalog, field, baseNode, draftNode),
    before: field.before,
    after: field.after,
  }));
}

export function comparisonNodeTitle(
  catalog: ExtensionCatalog,
  payload: WorkflowComparisonPayload,
  change: WorkflowNodeChange
): string {
  const { baseNode, draftNode } = nodeSnapshots(payload, change.nodeId);
  const node = change.kind === "removed" ? baseNode : draftNode;
  return node
    ? comparisonGraphNodeTitle(node.data, catalog)
    : "Unavailable action";
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
  const fields = comparisonFields(catalog, payload, change);
  const modified = change.kind === "modified";
  return (
    <section className="border-t p-4" data-testid="comparison-properties">
      <h3 className="font-medium text-sm">
        {comparisonNodeTitle(catalog, payload, change)}
      </h3>
      <p className="mt-1 text-muted-foreground text-xs">
        {modified
          ? "Published and current draft values"
          : change.kind === "added"
            ? "Current draft values"
            : "Published values"}
      </p>
      {modified ? (
        <div className="mt-4 grid grid-cols-2 gap-2 text-muted-foreground text-xs">
          <span>Published</span>
          <span>Current draft</span>
        </div>
      ) : null}
      <dl className="mt-3 space-y-3">
        {fields.map((field) => (
          <div
            className={modified ? "grid grid-cols-2 gap-2" : "space-y-1"}
            key={field.key}
          >
            <dt
              className={
                modified
                  ? "col-span-2 font-medium text-muted-foreground text-xs"
                  : "font-medium text-muted-foreground text-xs"
              }
            >
              {field.label}
            </dt>
            {modified ? (
              <dd className="min-w-0 rounded border bg-muted/30 px-2 py-1.5 text-xs break-words">
                {formatComparisonValue(field.before)}
              </dd>
            ) : null}
            <dd className="min-w-0 rounded border bg-muted/30 px-2 py-1.5 text-xs break-words">
              {formatComparisonValue(field.after)}
            </dd>
          </div>
        ))}
      </dl>
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
