/**
 * Whether a graph is ready to run, asked at the one gate that makes it runnable.
 *
 * Publish mints the immutable version every run reads and rewrites the event
 * subscription index, so this is the last point at which a refusal still costs
 * the builder nothing. `graph-save.ts` deliberately asks none of it: a draft is
 * allowed to be half-built, and refusing the save only threw the work away.
 *
 * An unreachable subtree is skipped at run time; a Canceled branch with no
 * Cancel Event is drawable and never entered (the editor shows it inactive).
 */

import { Effect } from "effect";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { annotateServiceSpan } from "#src/backend/lib/telemetry";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import {
  IntegrationValidationFailed,
  InvalidInput,
} from "#src/backend/lib/effect/failures";
import { validateWorkflowActionConfigs } from "#src/backend/services/workflows/validation/workflow-action-validation";
import { validateWorkflowIntegrations } from "#src/backend/services/workflows/validation/workflow-integration-validation";
import { validateWorkflowTemplates } from "#src/backend/services/workflows/validation/workflow-template-validation";
import {
  validateEventSplitOutlets,
  validateWorkflowEvents,
} from "#src/backend/services/workflows/validation/workflow-lifecycle-validation";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
  type LifecycleOutlet,
  nodesBehindOutlet,
} from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { configDeclaresCancelEvent } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";

export type PublishCheckResult =
  | { valid: true }
  | { valid: false; error: string };

const BOTH_OUTLETS: readonly LifecycleOutlet[] = [
  LIFECYCLE_STARTED_HANDLE,
  LIFECYCLE_CANCELED_HANDLE,
];

function lifecycleEntryIds(nodes: readonly WorkflowNode[]): Set<string> {
  return new Set(
    nodes
      .filter((node) => node.data.type === "lifecycle")
      .map((node) => node.id)
  );
}

function nodesBehindOutlets(input: {
  entryNodeIds: ReadonlySet<string>;
  outlets: readonly LifecycleOutlet[];
  edges: readonly WorkflowEdge[];
}): Set<string> {
  const reachable = new Set(input.entryNodeIds);
  for (const outlet of input.outlets) {
    for (const nodeId of nodesBehindOutlet({
      entryNodeIds: input.entryNodeIds,
      outlet,
      edges: input.edges,
    })) {
      reachable.add(nodeId);
    }
  }
  return reachable;
}

/**
 * Every node the engine can schedule from the Lifecycle Node: the entry nodes,
 * everything behind Started, and everything behind Canceled only when a Cancel
 * Event exists.
 */
export function reachableNodeIds(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): Set<string> {
  const includeCanceled = input.nodes.some(
    (node) =>
      node.data.type === "lifecycle" &&
      configDeclaresCancelEvent(node.data.config)
  );

  return nodesBehindOutlets({
    entryNodeIds: lifecycleEntryIds(input.nodes),
    outlets: includeCanceled ? BOTH_OUTLETS : [LIFECYCLE_STARTED_HANDLE],
    edges: input.edges,
  });
}

/**
 * Refuse nodes that hang off neither Lifecycle outlet.
 *
 * Deleting a node mid-chain orphans everything below it; the graph saves clean
 * and every run skips the orphans in silence.
 */
export function checkUnreachableSubtrees(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): PublishCheckResult {
  const connected = nodesBehindOutlets({
    entryNodeIds: lifecycleEntryIds(input.nodes),
    outlets: BOTH_OUTLETS,
    edges: input.edges,
  });
  const orphans = input.nodes
    .filter((node) => node.data.type !== "group" && !connected.has(node.id))
    .map((node) => node.data.label || node.id);

  if (orphans.length === 0) {
    return { valid: true };
  }

  const named =
    orphans.length === 1
      ? `"${orphans[0]}"`
      : `${orphans.length} nodes (including "${orphans[0]}")`;

  return {
    valid: false,
    error: `Unreachable ${named}: nothing from the Lifecycle Node reaches them. Connect them or delete them before publishing.`,
  };
}

/**
 * Everything a graph must satisfy to become runnable, in one fixed order, no
 * further than the first refusal.
 *
 * The order is the message a builder reads. A node's own configuration comes
 * first, because "no action selected" or a blank required field is what a
 * half-built canvas actually looks like and is the most direct thing to say. The
 * Events a graph names follow, then the shape of the branches carrying them, then
 * the template references reading across them. The integration references come
 * last because that check is the one that costs a query.
 *
 * `IntegrationValidationFailed` is the only failure that is not `InvalidInput`:
 * a graph naming ids this server cannot use is a different answer from a graph
 * the builder can finish in the editor.
 */
export const checkPublishReadiness = Effect.fn(
  "wfgraph.workflow.publish_readiness"
)(
  function* (input: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }) {
    const { nodes, edges } = input;
    const { catalog } = yield* Extensions;

    for (const check of [
      () => validateWorkflowActionConfigs(nodes, catalog),
      () => validateWorkflowEvents(nodes, catalog),
      () => validateEventSplitOutlets(nodes, edges, catalog),
      () => validateWorkflowTemplates({ nodes, edges, catalog }),
      () => checkUnreachableSubtrees({ nodes, edges }),
    ]) {
      const result = check();
      if (!result.valid) {
        return yield* new InvalidInput({ error: result.error });
      }
    }

    // The only way this fails is the integration rows it reads, so a rejected
    // query arrives here as the same database failure a repository answers with.
    // An unconfigured connection is InvalidInput; a present-but-bad id is the
    // typed integration failure.
    const integrations = yield* IntegrationRepo;
    const integrationValidation = yield* validateWorkflowIntegrations(
      nodes,
      catalog,
      integrations.typesByIds
    );
    if (!integrationValidation.valid) {
      if (integrationValidation.reason === "unconfigured") {
        return yield* new InvalidInput({ error: integrationValidation.error });
      }
      return yield* new IntegrationValidationFailed({
        error: "Invalid integration references in workflow",
        invalidIntegrationIds: integrationValidation.invalidIds,
      });
    }

    // The span carries no identifier of its own: it runs inside the publish span,
    // which names the workflow, and this takes a graph rather than a row.
    return "ready" as const;
  },
  Effect.tap((outcome) => annotateServiceSpan({ outcome }))
);
