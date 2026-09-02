/**
 * Canonical publish validation adapted to the build agent's snapshot result.
 *
 * The backend owns these checks because several depend on backend validation
 * modules. The agent receives one function through its draft service and keeps
 * its package dependency surface limited to shared runtime code.
 */

import type {
  AgentDocument,
  AgentPublicationValidation,
  ConnectedIntegration,
} from "@wfgraph/agent/document";
import { findAction } from "@wfgraph/shared/extensions/catalog";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { enabledActionTypeOf } from "@wfgraph/shared/graph/node-config";
import { collectWorkflowIssues } from "@wfgraph/shared/graph/workflow-issues";
import { checkUnreachableSubtrees } from "#src/backend/services/workflows/publish-checks";
import { validateWorkflowConditionConfigs } from "#src/backend/services/workflows/validation/workflow-conditions-validation";
import {
  validateEventSplitOutlets,
  validateStartFilters,
  validateWorkflowEvents,
} from "#src/backend/services/workflows/validation/workflow-lifecycle-validation";
import { validateWorkflowTemplates } from "#src/backend/services/workflows/validation/workflow-template-validation";

type ValidationIssue = AgentPublicationValidation["publishBlockers"][number];

function addUnique(issues: ValidationIssue[], issue: ValidationIssue): void {
  if (!issues.some((existing) => existing.message === issue.message)) {
    issues.push(issue);
  }
}

export function validateAgentPublication(input: {
  document: AgentDocument;
  catalog: ExtensionCatalog;
  integrations: readonly ConnectedIntegration[];
}): AgentPublicationValidation {
  const nodes = [...input.document.nodes];
  const edges = [...input.document.edges];
  const workflowIssues = collectWorkflowIssues({
    nodes,
    catalog: input.catalog,
    integrations: input.integrations,
  });
  const publishBlockers: ValidationIssue[] = workflowIssues
    .filter((issue) => issue.severity === "blocking")
    .map((issue) => ({
      kind: issue.kind,
      nodeId: issue.nodeId,
      nodeLabel: issue.nodeLabel,
      message: issue.message,
    }));
  const warnings: ValidationIssue[] = workflowIssues
    .filter((issue) => issue.severity === "warning")
    .map((issue) => ({
      kind: issue.kind,
      nodeId: issue.nodeId,
      nodeLabel: issue.nodeLabel,
      message: issue.message,
    }));

  for (const [kind, check] of [
    ["invalid_condition", () => validateWorkflowConditionConfigs(nodes)],
    ["invalid_event", () => validateWorkflowEvents(nodes, input.catalog)],
    // Publish refuses a Start Filter the graph cannot be run on, so the agent
    // has to see the same refusal: without it the agent reads an empty blocker
    // list as "ready to publish" and the person clicking Publish is the one who
    // finds out.
    ["invalid_start_filter", () => validateStartFilters(nodes, input.catalog)],
    [
      "invalid_event_split",
      () => validateEventSplitOutlets(nodes, edges, input.catalog),
    ],
    [
      "invalid_template",
      () => validateWorkflowTemplates({ nodes, edges, catalog: input.catalog }),
    ],
    ["unreachable_node", () => checkUnreachableSubtrees({ nodes, edges })],
  ] as const) {
    const result = check();
    if (!result.valid) {
      addUnique(publishBlockers, { kind, message: result.error });
    }
  }

  for (const node of nodes) {
    const actionId = enabledActionTypeOf(node);
    const integrationType = actionId
      ? findAction(input.catalog, actionId)?.integration
      : undefined;
    if (!integrationType) {
      continue;
    }
    const integrationId = node.data.config?.integrationId;
    if (
      typeof integrationId !== "string" ||
      !input.integrations.some(
        (integration) =>
          integration.id === integrationId &&
          integration.type === integrationType
      )
    ) {
      addUnique(publishBlockers, {
        kind: "missing_integration",
        nodeId: node.id,
        nodeLabel: node.data.label,
        message: `Node "${node.data.label || node.id}" needs a connected ${integrationType} integration.`,
      });
    }
  }

  return { publishBlockers, warnings };
}
