import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import type { DeterministicAssessment } from "#src/agent/assessment";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import { upstreamNodeIds } from "@wfgraph/shared/graph/upstream-nodes";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import { isBlank } from "@wfgraph/shared/types/string";
import { extractRequiredIntegrationRequirements } from "@wfgraph/core/backend/services/workflows/validation/workflow-integration-validation";
import type { AgentEvalDocument } from "#src/agent/result";

type ConnectedIntegration = { id: string; type: string };

type GraphAssessmentInput = {
  document: AgentEvalDocument;
  catalog: ExtensionCatalog;
  integrations: readonly ConnectedIntegration[];
};

const BUILT_INS = new Set<string>(Object.values(BUILT_IN_ACTION_IDS));

function failed(rationale: string): DeterministicAssessment {
  return { score: 0, rationale };
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
        } else {
          const source = input.document.nodes.find(
            (candidate) => candidate.id === token.nodeId
          );
          const sourceAction = source ? actionTypeOf(source) : undefined;
          const exposesPath =
            source?.data.type === "lifecycle"
              ? input.catalog.events.some((event) =>
                  event.payloadFields.some(
                    (field) => field.path === token.fieldPath
                  )
                )
              : sourceAction !== undefined &&
                findAction(input.catalog, sourceAction)?.outputFields.some(
                  (field) => field.path === token.fieldPath
                );
          if (!exposesPath) {
            issues.push(
              `unknown reference path ${token.fieldPath} on ${node.data.label || node.id}`
            );
          }
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
      !isBlank(integrationId) &&
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

  for (const requirement of extractRequiredIntegrationRequirements(
    input.document.nodes,
    input.catalog
  )) {
    const connected = input.integrations.find(
      (integration) => integration.id === requirement.integrationId
    );
    if (!connected) {
      const issue = `unknown integration ${requirement.integrationId} on ${requirement.nodeLabel}`;
      if (!issues.includes(issue)) {
        issues.push(issue);
      }
    } else if (connected.type !== requirement.requiredType) {
      issues.push(
        `integration ${requirement.integrationId} has type ${connected.type} but ${requirement.nodeLabel} requires ${requirement.requiredType}`
      );
    }
  }

  issues.push(...templateIssues(input));

  return issues.length === 0
    ? { score: 1, rationale: "Every graph identifier is grounded." }
    : failed(`${issues.join("; ")}.`);
}
