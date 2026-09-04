/**
 * Canonical draft and publish validation for the build agent's snapshot.
 *
 * The backend owns these checks because several depend on backend validation
 * modules. The agent receives the complete result through its draft service and
 * keeps its package dependency surface limited to shared runtime code.
 */

import type {
  AgentDocument,
  AgentDraftValidation,
  AgentPublicationValidation,
  AgentValidationIssue,
  ConnectedIntegration,
} from "@wfgraph/agent/document";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { serializeWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import {
  collectWorkflowIssues,
  type WorkflowIssue,
} from "@wfgraph/shared/graph/workflow-issues";
import { validateGraphSaveShape } from "#src/backend/services/workflows/graph-save";
import {
  collectSynchronousPublicationFailures,
  type SynchronousPublicationFailure,
} from "#src/backend/services/workflows/publish-checks";
import {
  extractRequiredIntegrationRequirements,
  shouldEnforceStrictIntegrationValidation,
} from "#src/backend/services/workflows/validation/workflow-integration-validation";

/** Every blocker kind produced by the concrete agent publication validator. */
export type AgentPublicationBlockerKind =
  | SynchronousPublicationFailure["kind"]
  | "missing_integration";

type PublicationBlocker = Omit<AgentValidationIssue, "kind"> & {
  readonly kind: AgentPublicationBlockerKind;
};

type BlockingWorkflowIssue = Extract<WorkflowIssue, { severity: "blocking" }>;

function integrationBlockerKey(nodeId: string, requiredType: string): string {
  return `${nodeId}\u0000${requiredType}`;
}

function toPublicationBlocker(
  issue: BlockingWorkflowIssue
): PublicationBlocker {
  return {
    kind: issue.kind,
    nodeId: issue.nodeId,
    nodeLabel: issue.nodeLabel,
    message: issue.message,
  };
}

export function validateAgentPublication(input: {
  document: AgentDocument;
  catalog: ExtensionCatalog;
  integrations: readonly ConnectedIntegration[];
}): AgentPublicationValidation {
  const nodes = [...input.document.nodes];
  const edges = [...input.document.edges];
  const strictIntegrationValidation =
    shouldEnforceStrictIntegrationValidation();
  const workflowIssues = collectWorkflowIssues({
    nodes,
    catalog: input.catalog,
    integrations: input.integrations,
  });
  const blockingWorkflowIssues = workflowIssues.filter(
    (issue): issue is BlockingWorkflowIssue => issue.severity === "blocking"
  );
  const warnings: AgentValidationIssue[] = workflowIssues
    .filter((issue) => issue.severity === "warning")
    .map((issue) => ({
      kind: issue.kind,
      nodeId: issue.nodeId,
      nodeLabel: issue.nodeLabel,
      message: issue.message,
    }));
  const publishBlockers: PublicationBlocker[] = [];

  for (const failure of collectSynchronousPublicationFailures({
    nodes,
    edges,
    catalog: input.catalog,
  })) {
    if (failure.kind === "missing_required_field") {
      const detailedFailures = blockingWorkflowIssues
        .filter((issue) => issue.kind === "missing_required_field")
        .map(toPublicationBlocker);
      publishBlockers.push(
        ...(detailedFailures.length > 0
          ? detailedFailures
          : [{ kind: failure.kind, message: failure.error }])
      );
      continue;
    }
    publishBlockers.push({ kind: failure.kind, message: failure.error });
  }

  if (!strictIntegrationValidation) {
    return { publishBlockers, warnings };
  }

  const missingIntegrationKeys = new Set<string>();
  for (const issue of blockingWorkflowIssues) {
    if (issue.kind !== "missing_integration") {
      continue;
    }
    const blockerKey = integrationBlockerKey(
      issue.nodeId,
      issue.integrationType
    );
    if (missingIntegrationKeys.has(blockerKey)) {
      continue;
    }
    publishBlockers.push(toPublicationBlocker(issue));
    missingIntegrationKeys.add(blockerKey);
  }
  for (const requirement of extractRequiredIntegrationRequirements(
    nodes,
    input.catalog
  )) {
    if (
      !input.integrations.some(
        (integration) =>
          integration.id === requirement.integrationId &&
          integration.type === requirement.requiredType
      )
    ) {
      if (
        missingIntegrationKeys.has(
          integrationBlockerKey(requirement.nodeId, requirement.requiredType)
        )
      ) {
        continue;
      }
      publishBlockers.push({
        kind: "missing_integration",
        nodeId: requirement.nodeId,
        nodeLabel: requirement.nodeLabel,
        message: `Node "${requirement.nodeLabel}" needs a connected ${requirement.requiredType} integration.`,
      });
      missingIntegrationKeys.add(
        integrationBlockerKey(requirement.nodeId, requirement.requiredType)
      );
    }
  }

  return { publishBlockers, warnings };
}

/** Combines structural and publication checks for one agent draft snapshot. */
export function validateAgentDraft(input: {
  document: AgentDocument;
  catalog: ExtensionCatalog;
  integrations: readonly ConnectedIntegration[];
}): AgentDraftValidation {
  const shapeValidation = validateGraphSaveShape(
    serializeWorkflowGraphData(input.document)
  );
  const publication = validateAgentPublication(input);

  return {
    draftValid: shapeValidation.valid,
    structuralIssues: shapeValidation.valid ? [] : [shapeValidation.error],
    ...publication,
  };
}
