import { useQuery } from "@tanstack/react-query";
import { partition } from "es-toolkit/array";
import { Fragment, type ReactNode, useState } from "react";
import {
  findAction,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import {
  fieldChangeCategory,
  isGroupFrameChange,
  type WorkflowChangeCategory,
} from "@wfgraph/shared/graph/change-classification";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import { currentTemplateDisplayText } from "@wfgraph/shared/graph/node-display";
import type {
  WorkflowComparisonPayload,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import { ACTION_TYPE_CONFIG_KEY } from "@wfgraph/shared/graph/node-config";
import { TEST_PAYLOADS_CONFIG_KEY } from "@wfgraph/shared/lifecycle/test-payloads";
import { compareText, isBlank } from "@wfgraph/shared/types/string";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import {
  type ComparisonConnection,
  comparisonFieldLabel,
  type ComparisonGraph,
  type ComparisonNode,
  ConditionValue,
  configFieldLabel,
  GENERIC_LABELS,
  groupConfigFieldLabel,
  isConditionRuleKey,
  isHiddenComparisonValue,
  readableConditionRules,
  readableValue,
  ValueNote,
} from "#src/components/workflow/comparison-field-labels";
import { ConditionSummary } from "#src/components/workflow/config/condition-summary";
import { TemplateText } from "#src/components/workflow/template-text";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import {
  type DiffRun,
  diffText,
  leadingTokens,
  textTokens,
  unifiedPieces,
} from "#src/lib/word-diff";

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

/** The two graphs a comparison compares, which is all most of this file reads. */
export type ComparisonGraphs = Pick<
  WorkflowComparisonPayload,
  "baseGraph" | "draftGraph"
>;

type ComparisonPayloadIndex = {
  base: ComparisonGraph;
  draft: ComparisonGraph;
  baseNodes: ReadonlyMap<string, ComparisonNode>;
  draftNodes: ReadonlyMap<string, ComparisonNode>;
};

/** A string longer than this many characters is shown shortened until expanded. */
export const LONG_VALUE_LENGTH = 200;
/** A string with more lines than this is shown shortened until expanded. */
const LONG_VALUE_LINES = 4;

const payloadIndexes = new WeakMap<ComparisonGraphs, ComparisonPayloadIndex>();

function payloadIndex(payload: ComparisonGraphs): ComparisonPayloadIndex {
  const existing = payloadIndexes.get(payload);
  if (existing) return existing;
  const base = toWorkflowGraphData(payload.baseGraph);
  const draft = toWorkflowGraphData(payload.draftGraph);
  const index = {
    base,
    draft,
    baseNodes: new Map(base.nodes.map((node) => [node.id, node])),
    draftNodes: new Map(draft.nodes.map((node) => [node.id, node])),
  };
  payloadIndexes.set(payload, index);
  return index;
}

/**
 * The nodes of each side of a comparison, which name the source of a template
 * reference in that side's values: `before` the published version's, `after`
 * the draft's.
 */
export type ComparisonSideNodes = {
  before: readonly ComparisonNode[];
  after: readonly ComparisonNode[];
};

export function comparisonSideNodes(
  payload: ComparisonGraphs
): ComparisonSideNodes {
  const index = payloadIndex(payload);
  return { before: index.base.nodes, after: index.draft.nodes };
}

/** The key of the one row a Condition's rules show as. */
const CONDITION_RULES_ROW_KEY = "condition-rules";

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

/**
 * Whether a string, as `text` reads once its template references show their
 * names, is long enough that it starts shortened.
 */
function isLongComparisonValue(text: string): boolean {
  return (
    text.length > LONG_VALUE_LENGTH ||
    text.split("\n").length > LONG_VALUE_LINES
  );
}

function snapshotFields(
  catalog: ExtensionCatalog,
  node: ComparisonNode,
  graph: ComparisonGraph,
  nodes: ReadonlyMap<string, ComparisonNode>,
  side: "before" | "after"
): ComparisonField[] {
  const config = node.data.config ?? {};
  const actionType = config.actionType;
  const configEntries = Object.entries(config)
    // The server comparison leaves test payloads out of a workflow's meaning,
    // so an added or removed node lists the same config keys a modified one
    // can report.
    .filter(
      ([key]) =>
        key !== ACTION_TYPE_CONFIG_KEY && key !== TEST_PAYLOADS_CONFIG_KEY
    )
    .toSorted(([left], [right]) => compareText(left, right));
  const [ruleEntries, settingEntries] = partition(configEntries, ([key]) =>
    isConditionRuleKey(actionType, key)
  );
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
      ...value(["data", "config", ACTION_TYPE_CONFIG_KEY], actionType),
    });
  if (ruleEntries.length > 0)
    fields.push({
      key: `snapshot:${CONDITION_RULES_ROW_KEY}`,
      label: configFieldLabel(catalog, actionType, "conditionModel"),
      [side]: readableConditionRules({ catalog, node, graph }),
    });
  return [
    ...fields,
    ...settingEntries.map(([key, raw]) => ({
      key: `snapshot:config:${key}`,
      label:
        node.data.type === "group"
          ? groupConfigFieldLabel([key])
          : configFieldLabel(catalog, actionType, key),
      ...value(["data", "config", key], raw),
    })),
  ];
}

/**
 * The node `nodeId` as the published graph and the draft graph each hold it,
 * undefined on a side that does not hold it.
 */
export function comparisonNodeSnapshots(
  payload: ComparisonGraphs,
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

/**
 * Whether `path`, a field path of the node `nodeId`, holds that node's
 * Condition rules, read from whichever side of `payload` holds the node.
 */
export function isConditionRulesPath(
  payload: ComparisonGraphs,
  nodeId: string,
  path: readonly string[]
): boolean {
  const { baseNode, draftNode } = comparisonNodeSnapshots(payload, nodeId);
  const actionType = (draftNode ?? baseNode)?.data.config?.actionType;
  return (
    path.length === 3 &&
    path[0] === "data" &&
    path[1] === "config" &&
    isConditionRuleKey(actionType, path[2])
  );
}

/** Whether `field`, a row of `comparisonFields`, is a modified Condition's rules. */
export function isConditionRulesRow(field: ComparisonField): boolean {
  return field.key === `field:${CONDITION_RULES_ROW_KEY}`;
}

/**
 * The property rows for a node change. An added node lists the draft's values
 * and a removed node the published values, each from its snapshot. A modified
 * node lists each changed property with both values. Identifiers read as names,
 * and a Connection id reads as a name from `options.connections` when that
 * list holds it. A Condition's rules are one row of sentences, however many of
 * its stored rule keys changed. Any other row's key is its path, and the path
 * plus its position only when the change lists that path more than once. Each
 * row of a modified node carries its category, Organization or Behavior.
 */
export function comparisonFields(
  catalog: ExtensionCatalog,
  payload: ComparisonGraphs,
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
    return snapshotFields(
      catalog,
      draftNode,
      index.draft,
      index.draftNodes,
      "after"
    );
  if (change.kind === "removed" && baseNode)
    return snapshotFields(
      catalog,
      baseNode,
      index.base,
      index.baseNodes,
      "before"
    );
  const pathKeys = change.fields.map((field) => JSON.stringify(field.path));
  const pathsUnique = new Set(pathKeys).size === pathKeys.length;
  const groupFrame = isGroupFrameChange({
    before: baseNode?.data.type,
    after: draftNode?.data.type,
  });
  const fieldRow = (
    field: WorkflowNodeChange["fields"][number],
    position: number,
    category: WorkflowChangeCategory
  ): ComparisonField => ({
    category,
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
  });
  const firstRulesPosition = change.fields.findIndex((field) =>
    isConditionRulesPath(payload, change.nodeId, field.path)
  );
  return change.fields.flatMap((field, position): ComparisonField[] => {
    const category = fieldChangeCategory({ path: field.path, groupFrame });
    if (isConditionRulesPath(payload, change.nodeId, field.path)) {
      return position === firstRulesPosition
        ? [
            {
              category,
              key: `field:${CONDITION_RULES_ROW_KEY}`,
              label: comparisonFieldLabel(catalog, field, baseNode, draftNode),
              before: readableConditionRules({
                catalog,
                node: baseNode,
                graph: index.base,
              }),
              after: readableConditionRules({
                catalog,
                node: draftNode,
                graph: index.draft,
              }),
            },
          ]
        : [];
    }
    return [fieldRow(field, position, category)];
  });
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
 * One comparison value. A missing value reads "Not set", a value the server
 * redacted or masked reads "Hidden for security", a stored condition reads as
 * sentences, and a string draws its template references as badges named from
 * `nodes`, the graph of the side the value comes from. A long string starts
 * shortened, with its length as it reads and a control that shows all of it.
 * The expanded state lives in this component, so keying it resets it.
 */
export function ComparisonValue({
  value,
  nodes,
}: {
  value: unknown;
  nodes: readonly ComparisonNode[];
}) {
  const catalog = useExtensionCatalog();
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
        nodes={value.nodes}
        setOperatorsRequireEnumValues={value.setOperatorsRequireEnumValues}
      />
    );
  }
  if (typeof value !== "string") {
    return (
      <span className="whitespace-pre-wrap">
        {formatComparisonValue(value)}
      </span>
    );
  }
  const shownText = currentTemplateDisplayText(value, nodes, catalog);
  if (!isLongComparisonValue(shownText)) {
    return (
      <span className="whitespace-pre-wrap">
        <TemplateText nodes={nodes} text={value} />
      </span>
    );
  }
  const opening = leadingTokens(textTokens(value), {
    maxLength: LONG_VALUE_LENGTH,
    maxLines: LONG_VALUE_LINES,
    lengthOf: (token) =>
      currentTemplateDisplayText(token, nodes, catalog).length,
  }).join("");
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="whitespace-pre-wrap" data-slot="comparison-long-value">
        <TemplateText
          nodes={nodes}
          text={expanded ? value : `${opening.trimEnd()}…`}
        />
      </span>
      <span className="text-muted-foreground">
        Long value, {shownText.length.toLocaleString()} characters
      </span>
      <ExpandToggle expanded={expanded} onToggle={setExpanded} />
    </span>
  );
}

/** The control that shows all of a shortened value, or shortens it again. */
function ExpandToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
}) {
  return (
    <Button
      aria-expanded={expanded}
      className="h-auto px-0 text-xs"
      onClick={() => onToggle(!expanded)}
      size="sm"
      type="button"
      variant="link"
    >
      {expanded ? "Show less" : "Show full value"}
    </Button>
  );
}

/**
 * The word-level difference between a row's two values, or null when the row
 * reads better as two plain values: a side is not a string, a side is hidden
 * or blank, or the two share no word, so marking every word would add nothing.
 */
function textDifference(field: ComparisonField): DiffRun[] | null {
  const { before, after } = field;
  if (
    typeof before !== "string" ||
    typeof after !== "string" ||
    isBlank(before) ||
    isBlank(after) ||
    isHiddenComparisonValue(before) ||
    isHiddenComparisonValue(after)
  ) {
    return null;
  }
  const runs = diffText(before, after);
  return runs.some(
    (run) => run.kind === "same" && run.tokens.some((token) => !isBlank(token))
  )
    ? runs
    : null;
}

/**
 * A text value's difference read as one flow: shared text plain, removed
 * words struck through on a red tint, and added words on a green tint, each
 * removal before the addition that replaces it. Template references draw as
 * badges, named from the published side's nodes for removed text and from
 * the newer side's nodes for the rest. A long difference folds the unchanged
 * text around its changes until the reader shows all of it.
 */
function UnifiedDifference({
  runs,
  nodes,
  long,
}: {
  runs: readonly DiffRun[];
  nodes: ComparisonSideNodes;
  long: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const folds =
    long &&
    unifiedPieces(runs, { fold: true }).some((piece) => piece.kind === "fold");
  // Each piece is keyed by its kind and the count of characters shown before
  // it, which stays the same for the same value.
  let shown = 0;
  const parts: ReactNode[] = [];
  for (const piece of unifiedPieces(runs, { fold: folds && !expanded })) {
    const key = `${piece.kind}:${shown}`;
    if (piece.kind === "fold") {
      parts.push(
        <span
          aria-label="Unchanged text"
          className="text-muted-foreground"
          key={key}
          role="img"
        >
          …
        </span>
      );
      continue;
    }
    if (piece.kind === "gap") {
      // The space between removed text and the text that replaces it.
      parts.push(<Fragment key={key}> </Fragment>);
      continue;
    }
    shown += piece.text.length;
    if (piece.kind === "same") {
      parts.push(
        <Fragment key={key}>
          <TemplateText nodes={nodes.after} text={piece.text} />
        </Fragment>
      );
    } else if (piece.kind === "removed") {
      parts.push(
        <del
          className="rounded-sm bg-destructive/15 decoration-destructive"
          key={key}
        >
          <TemplateText nodes={nodes.before} text={piece.text} />
        </del>
      );
    } else {
      parts.push(
        <ins className="rounded-sm bg-success/15 no-underline" key={key}>
          <TemplateText nodes={nodes.after} text={piece.text} />
        </ins>
      );
    }
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="whitespace-pre-wrap" data-slot="comparison-diff">
        {parts}
      </span>
      {folds ? (
        <ExpandToggle expanded={expanded} onToggle={setExpanded} />
      ) : null}
    </span>
  );
}

/**
 * What one changed setting reads as. Text that shares words with its earlier
 * value is one flow with the changed words marked. Any other value reads as
 * the earlier value struck through above the newer one, each with its label,
 * which is how a Condition's rules and a Wait's settings read in words.
 */
export function FieldDifference({
  field,
  nodes,
}: {
  field: ComparisonField;
  nodes: ComparisonSideNodes;
}) {
  const catalog = useExtensionCatalog();
  const runs = textDifference(field);
  if (runs !== null) {
    const long = [
      { text: field.before, sideNodes: nodes.before },
      { text: field.after, sideNodes: nodes.after },
    ].some(
      ({ text, sideNodes }) =>
        typeof text === "string" &&
        isLongComparisonValue(
          currentTemplateDisplayText(text, sideNodes, catalog)
        )
    );
    return <UnifiedDifference long={long} nodes={nodes} runs={runs} />;
  }
  return (
    <dl className="space-y-1">
      {field.before === undefined ? null : (
        <div className="min-w-0 break-words" data-side="before">
          <dt className="text-muted-foreground">Before</dt>
          <dd className="line-through decoration-destructive">
            <ComparisonValue nodes={nodes.before} value={field.before} />
          </dd>
        </div>
      )}
      <div className="min-w-0 break-words" data-side="after">
        <dt className="text-muted-foreground">Now</dt>
        <dd>
          <ComparisonValue nodes={nodes.after} value={field.after} />
        </dd>
      </div>
    </dl>
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
 * Settings as a list of labels and values, each value read the way the Draft
 * editor shows it. `nodes` names the template references in the values.
 */
export function SettingsList({
  fields,
  side,
  nodes,
  label,
}: {
  fields: readonly ComparisonField[];
  side: "before" | "after";
  nodes: readonly ComparisonNode[];
  /** The list's accessible name. */
  label: string;
}) {
  return (
    <dl aria-label={label} className="divide-y">
      {fields.map((field) => (
        <div className="min-w-0 space-y-0.5 py-1.5 break-words" key={field.key}>
          <dt className="text-muted-foreground">{field.label}</dt>
          <dd>
            <ComparisonValue nodes={nodes} value={field[side]} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
