import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import { upstreamNodeIds } from "@wfgraph/shared/graph/upstream-nodes";
import { workflowTopologyRefusalReason } from "@wfgraph/shared/graph/workflow-topology";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import { validateWorkflowActionConfigs } from "@wfgraph/core/backend/services/workflows/validation/workflow-action-validation";
import { validateWorkflowConditionConfigs } from "@wfgraph/core/backend/services/workflows/validation/workflow-conditions-validation";
import {
  validateEventSplitOutlets,
  validateWorkflowEvents,
} from "@wfgraph/core/backend/services/workflows/validation/workflow-lifecycle-validation";
import { validateWorkflowTemplates } from "@wfgraph/core/backend/services/workflows/validation/workflow-template-validation";
import { checkUnreachableSubtrees } from "@wfgraph/core/backend/services/workflows/publish-checks";
import type { AgentEvalDocument } from "#src/agent/result";

type ConnectedIntegration = { id: string; type: string };

type GraphAssessmentInput = {
  document: AgentEvalDocument;
  catalog: ExtensionCatalog;
  integrations: readonly ConnectedIntegration[];
};

export type DeterministicAssessment = {
  score: 0 | 1;
  rationale: string;
};

const BUILT_INS = new Set<string>(Object.values(BUILT_IN_ACTION_IDS));

function failed(rationale: string): DeterministicAssessment {
  return { score: 0, rationale };
}

/** Runs the pure parts of the same checks that guard workflow publication. */
export function assessPublishability(
  input: GraphAssessmentInput
): DeterministicAssessment {
  const { nodes, edges } = input.document;
  const topologyError = workflowTopologyRefusalReason({ nodes, edges });
  if (topologyError) {
    return failed(topologyError);
  }

  for (const check of [
    () => validateWorkflowActionConfigs(nodes, input.catalog),
    () => validateWorkflowConditionConfigs(nodes),
    () => validateWorkflowEvents(nodes, input.catalog),
    () => validateEventSplitOutlets(nodes, edges, input.catalog),
    () => validateWorkflowTemplates({ nodes, edges, catalog: input.catalog }),
    () => checkUnreachableSubtrees({ nodes, edges }),
  ]) {
    const result = check();
    if (!result.valid) {
      return failed(result.error);
    }
  }

  for (const node of nodes) {
    const actionId = actionTypeOf(node);
    if (!actionId) {
      continue;
    }
    const integrationType = findAction(input.catalog, actionId)?.integration;
    if (!integrationType) {
      continue;
    }
    const integrationId = node.data.config?.integrationId;
    const connected = input.integrations.some(
      (integration) =>
        integration.id === integrationId && integration.type === integrationType
    );
    if (!connected) {
      return failed(
        `Node "${node.data.label || node.id}" needs a connected ${integrationType} integration.`
      );
    }
  }

  return { score: 1, rationale: "The graph is ready to publish." };
}

function templateIssues(input: GraphAssessmentInput): string[] {
  const nodeIds = new Set(input.document.nodes.map((node) => node.id));
  const issues: string[] = [];

  for (const node of input.document.nodes) {
    const upstream = upstreamNodeIds(node.id, input.document.edges);
    for (const value of Object.values(node.data.config ?? {})) {
      if (typeof value !== "string") {
        continue;
      }
      for (const token of findTemplateTokens(value)) {
        if (!nodeIds.has(token.nodeId)) {
          issues.push(
            `missing reference ${token.nodeId} on ${node.data.label || node.id}`
          );
        } else if (!upstream.has(token.nodeId)) {
          issues.push(
            `non-upstream reference ${token.nodeId} on ${node.data.label || node.id}`
          );
        }
      }
    }
  }

  return issues;
}

/** Checks that every authored identifier comes from the scenario's evidence. */
export function assessGraphGrounding(
  input: GraphAssessmentInput
): DeterministicAssessment {
  const issues: string[] = [];

  for (const node of input.document.nodes) {
    const actionId = actionTypeOf(node);
    if (!actionId) {
      continue;
    }
    const action = findAction(input.catalog, actionId);
    if (!BUILT_INS.has(actionId) && !action) {
      issues.push(
        `Unknown action ${actionId} on ${node.data.label || node.id}`
      );
    }

    const integrationId = node.data.config?.integrationId;
    if (
      typeof integrationId === "string" &&
      !input.integrations.some(
        (integration) => integration.id === integrationId
      )
    ) {
      issues.push(
        `unknown integration ${integrationId} on ${node.data.label || node.id}`
      );
    }

    if (action) {
      const allowed = new Set([
        "actionType",
        "integrationId",
        ...flattenConfigFields(action.configFields).map((field) => field.key),
      ]);
      for (const key of Object.keys(node.data.config ?? {})) {
        if (!allowed.has(key)) {
          issues.push(`unknown field ${key} on ${node.data.label || node.id}`);
        }
      }
    }
  }

  issues.push(...templateIssues(input));

  return issues.length === 0
    ? { score: 1, rationale: "Every graph identifier is grounded." }
    : failed(`${issues.join("; ")}.`);
}
