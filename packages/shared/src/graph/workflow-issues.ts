/**
 * One issue model for the editor overlay and the collector that feeds it. The
 * editor's checks land here as one flat list, and the overlay grouping and "Run
 * draft anyway" are derived from it. A `blocking` issue stops Publish, and also
 * a draft run unless it is an `invalid_group` or a Publish-only Lifecycle check.
 */

import { groupBy, uniq, uniqBy } from "es-toolkit/array";
import {
  getMissingRequiredFieldsForNodes,
  type ResolveActionByType,
} from "#src/actions/action-config-validation";
import {
  type ExtensionCatalog,
  findAction,
  findIntegration,
} from "#src/extensions/catalog";
import {
  type GroupContractRule,
  groupContractViolations,
} from "#src/graph/group-contract";
import { readConfigTrimmedString } from "#src/graph/node-config";
import { checkCancelFilters } from "#src/lifecycle/cancel-filters";
import { checkEntityEligibility } from "#src/lifecycle/entity-eligibility";
import {
  checkLifecycleRules,
  type LifecycleRules,
  type LifecycleRulesCheck,
  readLifecycleRules,
} from "#src/lifecycle/lifecycle-rules";
import { checkStartFilters } from "#src/lifecycle/start-filters";
import { extractAllTemplateReferences } from "#src/graph/node-references";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import { flattenConfigFields } from "#src/plugins/action-fields";
import { readJsonObjectLeniently } from "#src/types/json";
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
 * A provider-backed field whose requirements could not be read at all.
 *
 * Only the operator's own connection can say what such a field still needs, so
 * a refused answer -- an expired grant, a connection deleted since the node was
 * wired, a provider that is down -- leaves that one field unjudged. It is a
 * warning rather than a blocker because nothing here says the field is wrong,
 * only that it went unchecked; the reader gets the node's name and a way into
 * it, and "Run draft anyway" stays available.
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
  severity: "warning";
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
 * runs `rules`, so a `rules` problem stops a draft run; the other three checks
 * stop Publish alone.
 */
export type LifecycleRulesCheckId =
  | "rules"
  | "entity_eligibility"
  | "start_filter"
  | "cancel_filter";

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
  | BrokenReferenceIssue;

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

function collectBrokenReferenceIssues(input: {
  nodes: WorkflowNode[];
  catalog: ExtensionCatalog;
}): BrokenReferenceIssue[] {
  const nodeIds = new Set(input.nodes.map((node) => node.id));
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

    const brokenRefs = extractAllTemplateReferences(config).filter(
      (ref) => !nodeIds.has(ref.nodeId)
    );
    if (brokenRefs.length === 0) {
      continue;
    }

    const actionType = readConfigTrimmedString(config, "actionType");
    const action = actionType
      ? findAction(input.catalog, actionType)
      : undefined;
    const flatFields = action ? flattenConfigFields(action.configFields) : [];
    const nodeLabel = workflowNodeLabel({
      node,
      actionLabel: action?.label,
      actionType,
    });

    for (const ref of brokenRefs) {
      const fieldLabel =
        flatFields.find((field) => field.key === ref.field)?.label ?? ref.field;
      issues.push({
        kind: "broken_reference",
        severity: "warning",
        nodeId: node.id,
        nodeLabel,
        fieldKey: ref.field,
        fieldLabel,
        referencedNodeId: ref.nodeId,
        displayText: ref.displayText,
        message: `Node "${nodeLabel}" references missing step in ${fieldLabel}`,
      });
    }
  }

  return issues;
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
    }) => LifecycleRulesCheck,
  ]
> = [
  ["rules", checkLifecycleRules],
  ["entity_eligibility", checkEntityEligibility],
  ["start_filter", checkStartFilters],
  ["cancel_filter", checkCancelFilters],
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
      const result = run({ rules, catalog: input.catalog });
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
    brokenReferences: groupIssuesByNode(
      byKind.broken_reference,
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
