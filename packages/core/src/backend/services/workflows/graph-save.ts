/**
 * What every path that writes a graph checks, in one fixed order, and the derived
 * rows that go with it.
 *
 * Four services write a graph -- create, patch, the editor's draft, and duplicate
 * -- and each used to spell the battery out again, which is how duplicate ended up
 * without the Lifecycle Rules check and how a path could write a graph while
 * skipping the subscription index derived from it. Both are one seam now: a caller
 * gets either a refusal to hand back or the nodes and the rows to write.
 *
 * The order is deliberate and the reason is the message a builder reads. The graph
 * has to parse before anything can be said about its nodes; a node's own
 * configuration is next, because a half-built node is the ordinary state of an
 * editor session; and the integration references come last because that check is
 * the one that costs a query.
 */

import { Effect } from "effect";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { Extensions } from "#src/backend/lib/effect/extensions";
import {
  IntegrationValidationFailed,
  InvalidInput,
} from "#src/backend/lib/effect/failures";
import { validateWorkflowConditionConfigs } from "#src/backend/services/workflows/validation/workflow-conditions-validation";
import { validateWorkflowGraph } from "#src/backend/services/workflows/validation/workflow-graph";
import { validateWorkflowIntegrations } from "#src/backend/services/workflows/validation/workflow-integration-validation";
import { validateWorkflowEvents } from "#src/backend/services/workflows/validation/workflow-lifecycle-validation";
import { deriveEventSubscriptions } from "#src/backend/services/workflows/lifecycle/subscriptions";
import type { WorkflowEventSubscriptionRow } from "#src/backend/services/workflows/repo";
import type {
  SerializedWorkflowGraph,
  WorkflowNode,
} from "@rova/shared/graph/types";

export type PreparedGraphSave = {
  graph: SerializedWorkflowGraph;
  nodes: WorkflowNode[];
  edgeCount: number;
  /**
   * The subscription index this graph calls for, for the workflow it is being
   * written to. It takes the id rather than carrying rows because a create and a
   * duplicate mint theirs after the graph is checked, and the draft never asks:
   * an Event may not start a run of a graph nobody has saved.
   */
  subscriptionsFor: (workflowId: string) => WorkflowEventSubscriptionRow[];
};

/**
 * Checks a graph and derives what a save writes beside it.
 *
 * The failures are the ones a caller already answers with: `InvalidInput` for
 * anything the builder can fix in the editor, `IntegrationValidationFailed` for a
 * graph naming integrations this server cannot use. A rejected query travels as
 * itself.
 *
 */
export const prepareGraphSave = Effect.fn("prepareGraphSave")(
  function* (input: { graph: unknown }) {
    const { catalog } = yield* Extensions;
    const graphValidation = validateWorkflowGraph(input.graph);
    if (!graphValidation.valid) {
      return yield* Effect.fail(
        new InvalidInput({ error: graphValidation.error })
      );
    }

    const { nodes, edges, graph } = graphValidation;

    const conditionValidation = validateWorkflowConditionConfigs(nodes);
    if (!conditionValidation.valid) {
      return yield* Effect.fail(
        new InvalidInput({ error: conditionValidation.error })
      );
    }

    const eventValidation = validateWorkflowEvents(nodes, catalog);
    if (!eventValidation.valid) {
      return yield* Effect.fail(
        new InvalidInput({ error: eventValidation.error })
      );
    }

    // The only way this fails is the integration rows it reads, so a rejected
    // query arrives here as the same database failure a repository answers with.
    const integrations = yield* IntegrationRepo;
    const integrationValidation = yield* validateWorkflowIntegrations(
      nodes,
      catalog,
      integrations.typesByIds
    );
    if (!integrationValidation.valid) {
      return yield* Effect.fail(
        new IntegrationValidationFailed({
          error: "Invalid integration references in workflow",
          invalidIntegrationIds: integrationValidation.invalidIds,
        })
      );
    }

    const prepared: PreparedGraphSave = {
      graph,
      nodes,
      edgeCount: edges.length,
      subscriptionsFor: (workflowId) =>
        deriveEventSubscriptions({ workflowId, nodes }),
    };
    return prepared;
  }
);
