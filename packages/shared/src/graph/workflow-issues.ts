/**
 * One issue model for the editor overlay and the collector that feeds it.
 *
 * The client pre-run checks (required fields, missing connections, orphan
 * template refs, and provider-backed fields that went unchecked) land here as a
 * flat discriminated list. Overlay grouping and "Run draft anyway" are derived
 * from that list so the toolbar is chrome, not a second validator. Server
 * save/preflight reuse the same required-field and missing-connection pieces;
 * wrapping every server refusal into this model is deferred.
 */

import { groupBy, uniq } from "es-toolkit/array";
import { isPlainObject } from "es-toolkit/predicate";
import {
  getMissingRequiredFieldsForNodes,
  type ResolveActionByType,
} from "#src/actions/action-config-validation";
import {
  type ExtensionCatalog,
  findAction,
  findIntegration,
} from "#src/extensions/catalog";
import { readConfigTrimmedString } from "#src/graph/node-config";
import { findTemplateTokens } from "#src/graph/node-references";
import type { WorkflowNode } from "#src/graph/types";
import { flattenConfigFields } from "#src/plugins/action-fields";
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

export type WorkflowIssue =
  | MissingRequiredFieldIssue
  | MissingIntegrationIssue
  | UnverifiedProviderFieldIssue
  | BrokenReferenceIssue;

export type CollectWorkflowIssuesInput = {
  nodes: WorkflowNode[];
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

export type WorkflowIssuesOverlayModel = {
  totalIssues: number;
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

function extractTemplateReferences(
  value: unknown
): Array<{ nodeId: string; displayText: string }> {
  if (typeof value !== "string") {
    return [];
  }

  return findTemplateTokens(value).map((token) => ({
    nodeId: token.nodeId,
    displayText: token.fieldPath
      ? `${token.nodeLabel}.${token.fieldPath}`
      : token.nodeLabel,
  }));
}

function extractAllTemplateReferences(
  config: Record<string, unknown>,
  prefix = ""
): Array<{ field: string; nodeId: string; displayText: string }> {
  const results: Array<{ field: string; nodeId: string; displayText: string }> =
    [];

  for (const [key, value] of Object.entries(config)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "string") {
      for (const ref of extractTemplateReferences(value)) {
        results.push({ field: fieldPath, ...ref });
      }
      continue;
    }

    if (isPlainObject(value)) {
      results.push(...extractAllTemplateReferences(value, fieldPath));
    }
  }

  return results;
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

    const config = node.data.config;
    if (!config || typeof config !== "object") {
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

/** Flat issue list for the three client pre-run checks. */
export function collectWorkflowIssues(
  input: CollectWorkflowIssuesInput
): WorkflowIssue[] {
  return [
    ...collectMissingRequiredFieldIssues(input),
    ...collectMissingIntegrationIssues(input),
    ...collectBrokenReferenceIssues(input),
  ];
}

export function hasBlockingWorkflowIssues(issues: WorkflowIssue[]): boolean {
  return issues.some((issue) => issue.severity === "blocking");
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
