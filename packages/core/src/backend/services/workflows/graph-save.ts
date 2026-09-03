/**
 * What every path that writes a graph checks, and the derived rows that go with
 * it.
 *
 * Four services write a graph -- create, patch, the editor's draft, and duplicate
 * -- and spelling the battery out separately at each is exactly how a path can
 * end up missing a check, or writing a graph while skipping the subscription
 * index derived from it. The battery and the derived-rows write are one seam
 * now: a caller gets either a refusal to hand back or the nodes and the rows to
 * write.
 *
 * This is the shape battery: it asks only what has to be true of a graph stored
 * in a row, that it parses and that its expressions are ones the compiler
 * produced. A half-built node is the ordinary state of an editor session, so it
 * saves. Whether a graph can run is asked once, at `publish-checks.ts`; ADR-0012's
 * 2026-08-17 amendment records why that is the only gate it needs.
 */

import { Effect } from "effect";
import { InvalidInput } from "#src/backend/lib/effect/failures";
import { validateWorkflowConditionConfigs } from "#src/backend/services/workflows/validation/workflow-conditions-validation";
import {
  validateCancelFilterModels,
  validateStartFilterModels,
} from "#src/backend/services/workflows/validation/workflow-lifecycle-validation";
import { validateWorkflowGraph } from "#src/backend/services/workflows/validation/workflow-graph";
import { deriveEventSubscriptions } from "#src/backend/services/workflows/lifecycle/subscriptions";
import type { WorkflowEventSubscriptionRow } from "#src/backend/services/workflows/repo";
import type {
  SerializedWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
} from "@wfgraph/shared/graph/types";

export type PreparedGraphSave = {
  graph: SerializedWorkflowGraph;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
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
 * Checks a graph's shape and derives what a save writes beside it.
 *
 * `InvalidInput` is the only failure, and it names something the builder can fix
 * in the editor. Nothing here reads the catalog or the database, so a draft save
 * costs no query and cannot be refused by an integration that was deleted since.
 */
export const prepareGraphSave = Effect.fn("prepareGraphSave")(
  function* (input: { graph: unknown }) {
    const graphValidation = validateWorkflowGraph(input.graph);
    if (!graphValidation.valid) {
      return yield* new InvalidInput({ error: graphValidation.error });
    }

    const { nodes, edges, graph } = graphValidation;

    // A stored expression has to be one the condition builder produced, because
    // nothing downstream can repair CEL that disagrees with its own model. This
    // check already tolerates the mid-edit states -- a blank condition, an
    // operand nobody has typed yet -- so it costs a builder nothing.
    const conditions = validateWorkflowConditionConfigs(nodes);
    if (!conditions.valid) {
      return yield* new InvalidInput({ error: conditions.error });
    }

    // The Lifecycle Node's own stored models, held to the same bar. Separate from
    // the walk above because that one is about action configs, and lifecycle
    // filters are not action configs.
    for (const filters of [
      validateStartFilterModels(nodes),
      validateCancelFilterModels(nodes),
    ]) {
      if (!filters.valid) {
        return yield* new InvalidInput({ error: filters.error });
      }
    }

    const prepared: PreparedGraphSave = {
      graph,
      nodes,
      edges,
      edgeCount: edges.length,
      subscriptionsFor: (workflowId) =>
        deriveEventSubscriptions({ workflowId, nodes }),
    };
    return prepared;
  }
);
