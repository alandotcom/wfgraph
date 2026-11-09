/**
 * One issue model for the editor overlay and the collector that feeds it. The
 * editor's checks land here as one flat list, and the overlay grouping and "Run
 * draft anyway" are derived from it. A `blocking` issue stops Publish, and also
 * a draft run unless it is an `invalid_group` or a Publish-only Lifecycle check.
 */

import { groupBy, uniq, uniqBy } from "es-toolkit/array";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import {
  getMissingRequiredFieldsForNodes,
  type ResolveActionByType,
} from "#src/actions/action-config-validation";
import {
  collectEntityStateConditionReferences,
  parseConditionModel,
} from "#src/conditions/conditions";
import { conditionTypeOf } from "#src/conditions/condition-field-type";
import {
  type ActionMetadata,
  type ExtensionCatalog,
  findAction,
  findIntegration,
} from "#src/extensions/catalog";
import {
  type GroupContractRule,
  groupContractViolations,
} from "#src/graph/group-contract";
import { isWaitNode, readConfigTrimmedString } from "#src/graph/node-config";
import { checkCancelFilters } from "#src/lifecycle/cancel-filters";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
  nodesBehindOutlet,
} from "#src/lifecycle/lifecycle-outlets";
import {
  checkEntityEligibility,
  findTrackedEntityStateSource,
} from "#src/lifecycle/entity-eligibility";
import {
  checkLifecycleRules,
  checkSchedulesAgainstEventSplits,
  type LifecycleRules,
  type LifecycleRulesCheck,
  readLifecycleRules,
} from "#src/lifecycle/lifecycle-rules";
import { checkStartFilters } from "#src/lifecycle/start-filters";
import {
  waitMatchTemplateStringsIn,
  waitTemplateKeysIn,
} from "#src/lifecycle/wait-subscription";
import {
  type ConfigTemplateReference,
  isEntityStateSourceId,
  referenceFieldForPath,
} from "#src/graph/node-references";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import { upstreamNodeIdsOver } from "#src/graph/upstream-nodes";
import {
  flattenConfigFields,
  literalFieldKeys,
  templateJsonFieldShapes,
} from "#src/plugins/action-fields";
import { extractConsumedTemplateReferences } from "#src/plugins/template-config";
import { type JsonObject, readJsonObjectLeniently } from "#src/types/json";
import { asNonEmptyString } from "#src/types/string";

export type MissingRequiredFieldIssue = {
  kind: "missing_required_field";
  severity: "blocking";
  nodeId: string;
  nodeLabel: string;
  fieldKey: string;
  fieldLabel: string;
  message: string;
};

export type MissingIntegrationIssue = {
  kind: "missing_integration";
  severity: "blocking";
  nodeId: string;
  nodeLabel: string;
  integrationType: string;
  integrationLabel: string;
  message: string;
};

/**
 * Guidance for a provider-backed field that cannot block a run.
 *
 * An integration provider can leave a field unchecked when its Connection
 * refuses or cannot answer. Application-scoped host fields are editor guidance,
 * so an unfilled value they declare stays a warning too. The reader gets the
 * node's name and a way into it, and "Run draft anyway" stays available.
 */
export type UnverifiedProviderFieldIssue = {
  kind: "unverified_provider_field";
  severity: "warning";
  nodeId: string;
  nodeLabel: string;
  fieldKey: string;
  fieldLabel: string;
  message: string;
};

export type BrokenReferenceIssue = {
  kind: "broken_reference";
  severity: "warning" | "blocking";
  nodeId: string;
  nodeLabel: string;
  fieldKey: string;
  fieldLabel: string;
  referencedNodeId: string;
  displayText: string;
  message: string;
};

/**
 * A template naming a node that has no path forward to the node holding it,
 * such as a node on a parallel branch.
 *
 * The engine resolves a node's templates from the outputs the run holds when
 * that node starts. Every upstream node has finished by then. Any other node
 * may or may not have run, depending on which branch the scheduler finishes
 * first, and when it has not, the action receives the template text in place
 * of the value. So this blocks Publish and a draft run alike. A reference to a
 * node missing from the graph is a `broken_reference`, and a node naming
 * itself is left to that same check, which accepts it.
 *
 * A node behind the Canceled outlet may read a node behind the Started outlet.
 * The Canceled Branch runs once the Started side has stopped at a boundary,
 * and it reads whatever outputs the run had produced by then.
 */
export type ReferenceNotUpstreamIssue = {
  kind: "reference_not_upstream";
  severity: "blocking";
  nodeId: string;
  nodeLabel: string;
  fieldKey: string;
  fieldLabel: string;
  referencedNodeId: string;
  displayText: string;
  message: string;
};

/**
 * A Group that breaks a v1 Group rule, from the same `groupContractViolations`
 * call publication makes. `nodeId` is the Group frame's id, so the frame wears
 * the badge. It stops Publish and leaves a draft run free, because Group
 * membership does not change how a run executes.
 */
export type InvalidGroupIssue = {
  kind: "invalid_group";
  severity: "blocking";
  nodeId: string;
  nodeLabel: string;
  rule: GroupContractRule;
  message: string;
};

/**
 * The Lifecycle Rules checks Publish runs on a Lifecycle Node. Preflight also
 * runs `rules`, so a `rules` problem stops a draft run; the other checks stop
 * Publish alone.
 */
export type LifecycleRulesCheckId =
  | "rules"
  | "entity_eligibility"
  | "start_filter"
  | "cancel_filter"
  | "schedule";

/**
 * A Lifecycle Node whose rules one Publish check refuses, with that check's
 * sentence. `nodeId` is the Lifecycle Node's id. Each check reports its first
 * problem, as Publish does.
 */
export type InvalidLifecycleRulesIssue = {
  kind: "invalid_lifecycle_rules";
  severity: "blocking";
  nodeId: string;
  nodeLabel: string;
  check: LifecycleRulesCheckId;
  message: string;
};

export type WorkflowIssue =
  | MissingRequiredFieldIssue
  | InvalidGroupIssue
  | InvalidLifecycleRulesIssue
  | MissingIntegrationIssue
  | UnverifiedProviderFieldIssue
  | BrokenReferenceIssue
  | ReferenceNotUpstreamIssue;

export type CollectWorkflowIssuesInput = {
  nodes: WorkflowNode[];
  /** The stored edges, which the Group rules read. */
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
  /**
   * Connections the operator can bind. An id absent from this list counts as
   * missing, matching the editor's pre-run check.
   */
  integrations: ReadonlyArray<{ id: string; type: string }>;
};

/** Overlay-shaped grouping kept for the issues dialog. */
export type BrokenReferenceGroup = {
  nodeId: string;
  nodeLabel: string;
  brokenReferences: Array<{
    fieldKey: string;
    fieldLabel: string;
    referencedNodeId: string;
    displayText: string;
  }>;
};

export type MissingRequiredFieldGroup = {
  nodeId: string;
  nodeLabel: string;
  missingFields: Array<{
    fieldKey: string;
    fieldLabel: string;
  }>;
};

export type MissingIntegrationGroup = {
  integrationType: string;
  integrationLabel: string;
  nodeNames: string[];
};

export type UnverifiedProviderFieldGroup = {
  nodeId: string;
  nodeLabel: string;
  fields: Array<{
    fieldKey: string;
    fieldLabel: string;
  }>;
};

type InvalidGroupEntry = {
  nodeId: string;
  nodeLabel: string;
  /**
   * Each distinct rule and sentence once. A rule id holds no hyphen, so
   * `${rule}-${message}` is a unique list key.
   */
  problems: Array<{ rule: GroupContractRule; message: string }>;
};

type InvalidLifecycleRulesEntry = {
  nodeId: string;
  nodeLabel: string;
  problems: Array<{ check: LifecycleRulesCheckId; message: string }>;
};

export type WorkflowIssuesOverlayModel = {
  totalIssues: number;
  /** How many issues stop a draft run. Each of them also stops Publish. */
  draftRunBlockingCount: number;
  /**
   * How many issues stop Publish. A Group problem and a Publish-only Lifecycle
   * Rules problem count here and are left out of `draftRunBlockingCount`.
   */
  publishBlockingCount: number;
  invalidGroups: InvalidGroupEntry[];
  invalidLifecycleRules: InvalidLifecycleRulesEntry[];
  brokenReferences: BrokenReferenceGroup[];
  missingRequiredFields: MissingRequiredFieldGroup[];
  missingIntegrations: MissingIntegrationGroup[];
  unverifiedProviderFields: UnverifiedProviderFieldGroup[];
};

type IntegrationLike = { id: string; type: string };

function resolveActionFromCatalog(
  catalog: ExtensionCatalog
): ResolveActionByType {
  return (actionType) => findAction(catalog, actionType);
}

/**
 * What a node is called in an issue, which is what the badge and the list read.
 *
 * Exported because the client raises issues the shared collector cannot: a
 * provider-backed field's requirements are answered by the operator's own
 * connection, and naming those nodes the same way is what keeps one list.
 */
export function workflowNodeLabel(input: {
  node: WorkflowNode;
  actionLabel?: string | undefined;
  actionType?: string | undefined;
}): string {
  const explicit = asNonEmptyString(input.node.data.label);
  if (explicit) {
    return explicit;
  }
  if (input.actionLabel) {
    return input.actionLabel;
  }
  if (input.actionType) {
    return input.actionType;
  }
  return input.node.id;
}

/**
 * Enabled action nodes that need a connection and do not name one.
 *
 * Present-but-invalid ids are a separate check (DB lookup on the server, the
 * operator's connection list in the editor). This is the half that needs no
 * query: the config key is blank.
 */
export function findUnconfiguredIntegrationNodes(input: {
  nodes: WorkflowNode[];
  catalog: ExtensionCatalog;
}): Array<{
  nodeId: string;
  nodeLabel: string;
  integrationType: string;
  integrationLabel: string;
}> {
  const { nodes, catalog } = input;
  const results: Array<{
    nodeId: string;
    nodeLabel: string;
    integrationType: string;
    integrationLabel: string;
  }> = [];

  for (const node of nodes) {
    if (node.data.type !== "action" || node.data.enabled === false) {
      continue;
    }

    const actionType = readConfigTrimmedString(node.data.config, "actionType");
    if (!actionType) {
      continue;
    }

    const action = findAction(catalog, actionType);
    const integrationType = action?.integration;
    if (!integrationType) {
      continue;
    }

    if (readConfigTrimmedString(node.data.config, "integrationId")) {
      continue;
    }

    const integrationLabel =
      findIntegration(catalog, integrationType)?.label ?? integrationType;
    const nodeLabel = workflowNodeLabel({
      node,
      actionLabel: action?.label,
      actionType,
    });

    results.push({
      nodeId: node.id,
      nodeLabel,
      integrationType,
      integrationLabel,
    });
  }

  return results;
}

function collectMissingRequiredFieldIssues(input: {
  nodes: WorkflowNode[];
  catalog: ExtensionCatalog;
}): MissingRequiredFieldIssue[] {
  return getMissingRequiredFieldsForNodes({
    nodes: input.nodes,
    resolveActionByType: resolveActionFromCatalog(input.catalog),
  }).flatMap((nodeIssue) =>
    nodeIssue.missingFields.map((field) => ({
      kind: "missing_required_field" as const,
      severity: "blocking" as const,
      nodeId: nodeIssue.nodeId,
      nodeLabel: nodeIssue.nodeLabel,
      fieldKey: field.fieldKey,
      fieldLabel: field.fieldLabel,
      message: `Node "${nodeIssue.nodeLabel}" is missing required field "${field.fieldLabel}"`,
    }))
  );
}

function collectMissingIntegrationIssues(input: {
  nodes: WorkflowNode[];
  catalog: ExtensionCatalog;
  integrations: ReadonlyArray<IntegrationLike>;
}): MissingIntegrationIssue[] {
  const knownIds = new Set(input.integrations.map((item) => item.id));
  const issues: MissingIntegrationIssue[] = [];

  for (const node of input.nodes) {
    if (node.data.type !== "action" || node.data.enabled === false) {
      continue;
    }

    const actionType = readConfigTrimmedString(node.data.config, "actionType");
    if (!actionType) {
      continue;
    }

    const action = findAction(input.catalog, actionType);
    const integrationType = action?.integration;
    if (!integrationType) {
      continue;
    }

    const configuredId = readConfigTrimmedString(
      node.data.config,
      "integrationId"
    );
    if (configuredId && knownIds.has(configuredId)) {
      continue;
    }

    const integrationLabel =
      findIntegration(input.catalog, integrationType)?.label ?? integrationType;
    const nodeLabel = workflowNodeLabel({
      node,
      actionLabel: action?.label,
      actionType,
    });

    issues.push({
      kind: "missing_integration",
      severity: "blocking",
      nodeId: node.id,
      nodeLabel,
      integrationType,
      integrationLabel,
      message: `Node "${nodeLabel}" needs a ${integrationLabel} connection`,
    });
  }

  return issues;
}

/**
 * The template references in a node's config that the engine resolves. A key
 * the action declares literal is handed over as authored, and a Wait's key its
 * current shape does not read is never consulted, so neither is included.
 */
function consumedReferencesOf(input: {
  node: WorkflowNode;
  config: JsonObject;
  action: ActionMetadata | undefined;
}): ConfigTemplateReference[] {
  const waitNode = isWaitNode(input.node);
  const configFields = input.action?.configFields ?? [];
  return extractConsumedTemplateReferences(
    input.config,
    {
      literalKeys: new Set(literalFieldKeys(configFields)),
      jsonShapes: new Map(templateJsonFieldShapes(configFields)),
      activeKeys: waitNode
        ? new Set<string>(waitTemplateKeysIn(input.config))
        : undefined,
    },
    waitNode ? waitMatchTemplateStringsIn(input.config) : []
  );
}

/** The label of the config field a reference sits in, or its dotted key. */
function referenceFieldLabelOf(
  reference: ConfigTemplateReference,
  action: ActionMetadata | undefined
): string {
  return (
    flattenConfigFields(action?.configFields ?? []).find(
      (field) => field.key === reference.configKey
    )?.label ?? reference.field
  );
}

function collectBrokenReferenceIssues(input: {
  nodes: WorkflowNode[];
  catalog: ExtensionCatalog;
}): BrokenReferenceIssue[] {
  const nodeIds = new Set(input.nodes.map((node) => node.id));
  const lifecycleRules = input.nodes
    .filter((node) => node.data.type === "lifecycle")
    .map((node) => readLifecycleRules(node.data.config))
    .find((rules) => rules !== undefined);
  const entitySource = findTrackedEntityStateSource({
    rules: lifecycleRules,
    catalog: input.catalog,
  });
  const issues: BrokenReferenceIssue[] = [];

  for (const node of input.nodes) {
    if (node.data.enabled === false) {
      continue;
    }

    // A config is JSON, and a live one holds `undefined` under a key the editor
    // cleared, which this read drops so the templates beside it are still seen.
    const config = readJsonObjectLeniently(node.data.config);
    if (!config) {
      continue;
    }

    const actionType = readConfigTrimmedString(config, "actionType");
    const action = actionType
      ? findAction(input.catalog, actionType)
      : undefined;
    const parsedCondition =
      actionType === BUILT_IN_ACTION_IDS.condition
        ? parseConditionModel(config.conditionModel)
        : undefined;
    const brokenEntityConditionRefs =
      parsedCondition?.valid === true
        ? collectEntityStateConditionReferences(parsedCondition.model).filter(
            (reference) => {
              if (!entitySource || reference.entityType !== entitySource.type) {
                return true;
              }
              const field = referenceFieldForPath(
                entitySource.stateFields,
                reference.fieldPath
              );
              return !field || conditionTypeOf(field) !== reference.fieldType;
            }
          )
        : [];
    const brokenRefs = consumedReferencesOf({ node, config, action }).filter(
      (ref) => {
        if (isEntityStateSourceId(ref.nodeId)) {
          return !(
            entitySource &&
            ref.sourceType === entitySource.type &&
            ref.fieldPath &&
            referenceFieldForPath(entitySource.stateFields, ref.fieldPath)
          );
        }
        return !nodeIds.has(ref.nodeId);
      }
    );
    if (brokenRefs.length === 0 && brokenEntityConditionRefs.length === 0) {
      continue;
    }

    const nodeLabel = workflowNodeLabel({
      node,
      actionLabel: action?.label,
      actionType,
    });

    for (const reference of brokenEntityConditionRefs) {
      issues.push({
        kind: "broken_reference",
        severity: "blocking",
        nodeId: node.id,
        nodeLabel,
        fieldKey: "conditionModel",
        fieldLabel: "Continue when",
        referencedNodeId: "$entity",
        displayText: `${reference.entityType}.${reference.fieldPath}`,
        message: `Node "${nodeLabel}" references unavailable Entity data in Continue when`,
      });
    }

    for (const ref of brokenRefs) {
      const fieldLabel = referenceFieldLabelOf(ref, action);
      const entityReference = isEntityStateSourceId(ref.nodeId);
      issues.push({
        kind: "broken_reference",
        severity: entityReference ? "blocking" : "warning",
        nodeId: node.id,
        nodeLabel,
        fieldKey: ref.field,
        fieldLabel,
        referencedNodeId: ref.nodeId,
        displayText: ref.displayText,
        message: entityReference
          ? `Node "${nodeLabel}" references unavailable Entity data in ${fieldLabel}`
          : `Node "${nodeLabel}" references missing step in ${fieldLabel}`,
      });
    }
  }

  return issues;
}

/**
 * Every template that names another node of the graph which is not upstream of
 * the node holding it, leaving out a Canceled-side node reading a Started-side
 * one. Only an enabled action node resolves its templates, so only those are
 * read. Publish and the run preflight report the same list through
 * `validateUpstreamTemplateReferences`, so the editor, the build agent and the
 * server refuse one set of references.
 */
export function collectReferenceNotUpstreamIssues(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): ReferenceNotUpstreamIssue[] {
  // A Map, because node ids are chosen by the builder.
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const upstreamOf = upstreamNodeIdsOver(input.edges);
  const entryNodeIds = new Set(
    input.nodes
      .filter((node) => node.data.type === "lifecycle")
      .map((node) => node.id)
  );
  const startedSide = nodesBehindOutlet({
    entryNodeIds,
    outlet: LIFECYCLE_STARTED_HANDLE,
    edges: input.edges,
  });
  const canceledSide = nodesBehindOutlet({
    entryNodeIds,
    outlet: LIFECYCLE_CANCELED_HANDLE,
    edges: input.edges,
  });
  const labelOf = (node: WorkflowNode): string => {
    const actionType = readConfigTrimmedString(node.data.config, "actionType");
    return workflowNodeLabel({
      node,
      actionLabel: actionType
        ? findAction(input.catalog, actionType)?.label
        : undefined,
      actionType,
    });
  };

  return input.nodes.flatMap((node) => {
    if (node.data.type !== "action" || node.data.enabled === false) {
      return [];
    }
    const config = readJsonObjectLeniently(node.data.config);
    if (!config) {
      return [];
    }

    const actionType = readConfigTrimmedString(config, "actionType");
    const action = actionType
      ? findAction(input.catalog, actionType)
      : undefined;
    // A missing node and the node itself are judged by the broken-reference
    // check, so only a reference to another node of this graph is held here.
    const crossNode = consumedReferencesOf({ node, config, action }).filter(
      (reference) =>
        reference.nodeId !== node.id && nodeById.has(reference.nodeId)
    );
    if (crossNode.length === 0) {
      return [];
    }

    const upstream = upstreamOf(node.id);
    const readsStartedSide = canceledSide.has(node.id);
    const nodeLabel = labelOf(node);
    return crossNode.flatMap((reference) => {
      const referenced = nodeById.get(reference.nodeId);
      if (
        !referenced ||
        upstream.has(referenced.id) ||
        (readsStartedSide && startedSide.has(referenced.id))
      ) {
        return [];
      }
      const referencedLabel = labelOf(referenced);
      const fieldLabel = referenceFieldLabelOf(reference, action);
      return [
        {
          kind: "reference_not_upstream" as const,
          severity: "blocking" as const,
          nodeId: node.id,
          nodeLabel,
          fieldKey: reference.field,
          fieldLabel,
          referencedNodeId: referenced.id,
          displayText: reference.displayText,
          message: `Node "${nodeLabel}" reads "${referencedLabel}" in ${fieldLabel}, but no path leads from "${referencedLabel}" to "${nodeLabel}". Reference only a node upstream of "${nodeLabel}", or move "${nodeLabel}" below "${referencedLabel}".`,
        },
      ];
    });
  });
}

function collectInvalidGroupIssues(input: {
  nodes: WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): InvalidGroupIssue[] {
  return groupContractViolations(input).map((violation) => ({
    kind: "invalid_group",
    severity: "blocking",
    nodeId: violation.groupId,
    nodeLabel: violation.groupLabel,
    rule: violation.rule,
    message: violation.message,
  }));
}

/** Each Lifecycle Rules check Publish runs, in the order Publish runs them. */
const LIFECYCLE_RULES_CHECKS: ReadonlyArray<
  readonly [
    LifecycleRulesCheckId,
    (input: {
      rules: LifecycleRules;
      catalog: ExtensionCatalog;
      nodes: readonly WorkflowNode[];
    }) => LifecycleRulesCheck,
  ]
> = [
  ["rules", checkLifecycleRules],
  ["entity_eligibility", checkEntityEligibility],
  ["start_filter", checkStartFilters],
  ["cancel_filter", checkCancelFilters],
  ["schedule", checkSchedulesAgainstEventSplits],
];

/**
 * The Lifecycle Rules checks Publish runs, on every Lifecycle Node that stores
 * rules. A node with no stored rules passes, as it does at Publish.
 */
function collectInvalidLifecycleRulesIssues(input: {
  nodes: WorkflowNode[];
  catalog: ExtensionCatalog;
}): InvalidLifecycleRulesIssue[] {
  return input.nodes.flatMap((node) => {
    const rules =
      node.data.type === "lifecycle"
        ? readLifecycleRules(node.data.config)
        : null;
    if (!rules) {
      return [];
    }
    const nodeLabel = workflowNodeLabel({ node });
    return LIFECYCLE_RULES_CHECKS.flatMap(([check, run]) => {
      const result = run({ rules, catalog: input.catalog, nodes: input.nodes });
      return result.valid
        ? []
        : [
            {
              kind: "invalid_lifecycle_rules" as const,
              severity: "blocking" as const,
              nodeId: node.id,
              nodeLabel,
              check,
              message: result.error,
            },
          ];
    });
  });
}

/** Flat issue list for the client pre-run checks that need no provider. */
export function collectWorkflowIssues(
  input: CollectWorkflowIssuesInput
): WorkflowIssue[] {
  return [
    ...collectMissingRequiredFieldIssues(input),
    ...collectMissingIntegrationIssues(input),
    ...collectBrokenReferenceIssues(input),
    ...collectReferenceNotUpstreamIssues(input),
    ...collectInvalidGroupIssues(input),
    ...collectInvalidLifecycleRulesIssues(input),
  ];
}

/** Whether any issue stops Publish. */
export function hasBlockingWorkflowIssues(
  issues: readonly WorkflowIssue[]
): boolean {
  return issues.some((issue) => issue.severity === "blocking");
}

function blocksDraftRun(issue: WorkflowIssue): boolean {
  switch (issue.kind) {
    case "invalid_group":
      return false;
    case "invalid_lifecycle_rules":
      return issue.check === "rules";
    case "broken_reference":
      return (
        issue.severity === "blocking" &&
        !isEntityStateSourceId(issue.referencedNodeId)
      );
    default:
      return issue.severity === "blocking";
  }
}

/**
 * Whether any issue stops a draft run: every blocking issue except a Group
 * problem and a Lifecycle Rules problem that only Publish checks.
 */
export function hasDraftRunBlockingIssues(
  issues: readonly WorkflowIssue[]
): boolean {
  return issues.some(blocksDraftRun);
}

/** The issues of one kind, each narrowed to that kind's own fields. */
function issuesOfKind<Kind extends WorkflowIssue["kind"]>(
  issues: readonly WorkflowIssue[],
  kind: Kind
): Array<Extract<WorkflowIssue, { kind: Kind }>> {
  return issues.filter(
    (issue): issue is Extract<WorkflowIssue, { kind: Kind }> =>
      issue.kind === kind
  );
}

type IssuesByKind = {
  [Kind in WorkflowIssue["kind"]]: Array<
    Extract<WorkflowIssue, { kind: Kind }>
  >;
};

/**
 * One list per issue kind. The return type is keyed over the whole
 * `WorkflowIssue["kind"]` union, so a kind added to `WorkflowIssue` fails to
 * compile here until the overlay groups it.
 */
function issuesByKind(issues: readonly WorkflowIssue[]): IssuesByKind {
  return {
    missing_required_field: issuesOfKind(issues, "missing_required_field"),
    missing_integration: issuesOfKind(issues, "missing_integration"),
    invalid_group: issuesOfKind(issues, "invalid_group"),
    invalid_lifecycle_rules: issuesOfKind(issues, "invalid_lifecycle_rules"),
    broken_reference: issuesOfKind(issues, "broken_reference"),
    reference_not_upstream: issuesOfKind(issues, "reference_not_upstream"),
    unverified_provider_field: issuesOfKind(
      issues,
      "unverified_provider_field"
    ),
  };
}

/**
 * One group per node, ordered by where the issue list first names each node.
 *
 * Every issue of a node repeats that node's label, so the header is written
 * once here and each caller says only what one issue contributes to its group.
 */
function groupIssuesByNode<
  Issue extends { nodeId: string; nodeLabel: string },
  Group,
>(
  issues: readonly Issue[],
  toGroup: (
    node: { nodeId: string; nodeLabel: string },
    nodeIssues: Issue[]
  ) => Group
): Group[] {
  // A Map rather than a groupBy record: a node id is text the saved graph or
  // the build agent chose, and es-toolkit's groupBy writes `result[key] = []`,
  // which for `__proto__` replaces the prototype instead of starting a group.
  const byNode = new Map<string, Issue[]>();
  for (const issue of issues) {
    const existing = byNode.get(issue.nodeId);
    if (existing) {
      existing.push(issue);
      continue;
    }
    byNode.set(issue.nodeId, [issue]);
  }

  return [...byNode.values()].map((nodeIssues) =>
    toGroup(
      { nodeId: nodeIssues[0].nodeId, nodeLabel: nodeIssues[0].nodeLabel },
      nodeIssues
    )
  );
}

/** What a field-shaped issue contributes to its node's group. */
function issueFieldEntry(issue: { fieldKey: string; fieldLabel: string }): {
  fieldKey: string;
  fieldLabel: string;
} {
  return { fieldKey: issue.fieldKey, fieldLabel: issue.fieldLabel };
}

/** Group a flat issue list into the shape the issues overlay renders. */
export function groupWorkflowIssuesForOverlay(
  issues: WorkflowIssue[]
): WorkflowIssuesOverlayModel {
  const byKind = issuesByKind(issues);
  const missingIntegrationsByType = Object.values(
    groupBy(byKind.missing_integration, (issue) => issue.integrationType)
  );

  return {
    totalIssues: issues.length,
    draftRunBlockingCount: issues.filter(blocksDraftRun).length,
    publishBlockingCount: issues.filter(
      (issue) => issue.severity === "blocking"
    ).length,
    invalidGroups: groupIssuesByNode(
      byKind.invalid_group,
      (node, nodeIssues) => ({
        ...node,
        // Two joins with the same label word their problem the same way, and
        // the reader learns nothing from the second copy.
        problems: uniqBy(
          nodeIssues.map((issue) => ({
            rule: issue.rule,
            message: issue.message,
          })),
          (problem) => `${problem.rule}-${problem.message}`
        ),
      })
    ),
    invalidLifecycleRules: groupIssuesByNode(
      byKind.invalid_lifecycle_rules,
      (node, nodeIssues) => ({
        ...node,
        problems: nodeIssues.map((issue) => ({
          check: issue.check,
          message: issue.message,
        })),
      })
    ),
    missingRequiredFields: groupIssuesByNode(
      byKind.missing_required_field,
      (node, nodeIssues) => ({
        ...node,
        missingFields: nodeIssues.map(issueFieldEntry),
      })
    ),
    missingIntegrations: missingIntegrationsByType.map((typeIssues) => ({
      integrationType: typeIssues[0].integrationType,
      integrationLabel: typeIssues[0].integrationLabel,
      // Two nodes can need the same missing connection, and the overlay names
      // each node once.
      nodeNames: uniq(typeIssues.map((issue) => issue.nodeLabel)),
    })),
    // A reference to a node that is not upstream is listed with the broken
    // ones: both are repaired by editing the same field.
    brokenReferences: groupIssuesByNode(
      [...byKind.broken_reference, ...byKind.reference_not_upstream],
      (node, nodeIssues) => ({
        ...node,
        brokenReferences: nodeIssues.map((issue) => ({
          ...issueFieldEntry(issue),
          referencedNodeId: issue.referencedNodeId,
          displayText: issue.displayText,
        })),
      })
    ),
    unverifiedProviderFields: groupIssuesByNode(
      byKind.unverified_provider_field,
      (node, nodeIssues) => ({
        ...node,
        fields: nodeIssues.map(issueFieldEntry),
      })
    ),
  };
}
