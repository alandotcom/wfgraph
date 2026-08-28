/**
 * One issue model for the editor overlay and the collector that feeds it.
 *
 * The three client pre-run checks (required fields, missing connections, orphan
 * template refs) land here as a flat discriminated list. Overlay grouping and
 * Run Anyway are derived from that list so the toolbar is chrome, not a second
 * validator. Server save/preflight reuse the same required-field and missing-
 * connection pieces; wrapping every server refusal into this model is deferred.
 */

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

export type WorkflowIssuesOverlayModel = {
  totalIssues: number;
  brokenReferences: BrokenReferenceGroup[];
  missingRequiredFields: MissingRequiredFieldGroup[];
  missingIntegrations: MissingIntegrationGroup[];
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
  actionLabel?: string;
  actionType?: string;
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

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested: Record<string, unknown> = { ...value };
      results.push(...extractAllTemplateReferences(nested, fieldPath));
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

/** Group a flat issue list into the shape the issues overlay renders. */
export function groupWorkflowIssuesForOverlay(
  issues: WorkflowIssue[]
): WorkflowIssuesOverlayModel {
  const missingRequiredByNode = new Map<string, MissingRequiredFieldGroup>();
  const brokenByNode = new Map<string, BrokenReferenceGroup>();
  const missingByType = new Map<string, MissingIntegrationGroup>();

  for (const issue of issues) {
    switch (issue.kind) {
      case "missing_required_field": {
        const existing = missingRequiredByNode.get(issue.nodeId);
        if (existing) {
          existing.missingFields.push({
            fieldKey: issue.fieldKey,
            fieldLabel: issue.fieldLabel,
          });
          break;
        }
        missingRequiredByNode.set(issue.nodeId, {
          nodeId: issue.nodeId,
          nodeLabel: issue.nodeLabel,
          missingFields: [
            { fieldKey: issue.fieldKey, fieldLabel: issue.fieldLabel },
          ],
        });
        break;
      }
      case "broken_reference": {
        const existing = brokenByNode.get(issue.nodeId);
        if (existing) {
          existing.brokenReferences.push({
            fieldKey: issue.fieldKey,
            fieldLabel: issue.fieldLabel,
            referencedNodeId: issue.referencedNodeId,
            displayText: issue.displayText,
          });
          break;
        }
        brokenByNode.set(issue.nodeId, {
          nodeId: issue.nodeId,
          nodeLabel: issue.nodeLabel,
          brokenReferences: [
            {
              fieldKey: issue.fieldKey,
              fieldLabel: issue.fieldLabel,
              referencedNodeId: issue.referencedNodeId,
              displayText: issue.displayText,
            },
          ],
        });
        break;
      }
      case "missing_integration": {
        const existing = missingByType.get(issue.integrationType);
        if (existing) {
          if (!existing.nodeNames.includes(issue.nodeLabel)) {
            existing.nodeNames.push(issue.nodeLabel);
          }
          break;
        }
        missingByType.set(issue.integrationType, {
          integrationType: issue.integrationType,
          integrationLabel: issue.integrationLabel,
          nodeNames: [issue.nodeLabel],
        });
        break;
      }
      default: {
        issue satisfies never;
        throw new Error("Unhandled workflow issue");
      }
    }
  }

  return {
    totalIssues: issues.length,
    missingRequiredFields: Array.from(missingRequiredByNode.values()),
    missingIntegrations: Array.from(missingByType.values()),
    brokenReferences: Array.from(brokenByNode.values()),
  };
}
