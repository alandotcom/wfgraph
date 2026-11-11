/**
 * The traversal's own state: the graph indexed for lookup, what each node left
 * behind, and how far round the graph the run has got.
 *
 * Holding it in one value is what lets `markReadyForDownstream` state the rule a
 * scheduler has to follow. The scheduler itself is in `scheduler.ts`.
 *
 * A node with one predecessor runs as soon as that node releases it. A node
 * with several is an AND-join: `isReadyToRun` is true only once every
 * predecessor has released, which is how two lookups can both feed the next
 * step. Saving refuses joins that would hang (Wait on an arm, exclusive
 * branches, Started↔Canceled).
 */

import { Effect } from "effect";
import { normalizeConditionBranch } from "@wfgraph/shared/conditions/condition-branch";
import { isLifecycleNode } from "@wfgraph/shared/graph/node-config";
import type {
  ConditionBranch,
  WorkflowEdge,
  WorkflowNode,
} from "@wfgraph/shared/graph/types";
import { eventSplitOutletEvent } from "@wfgraph/shared/lifecycle/event-split";
import type { LifecycleOutlet } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { JsonObject } from "@wfgraph/shared/types/json";
import {
  type ExecutionResult,
  executionData,
  executionFailure,
  type NodeOutputs,
} from "#src/backend/engine/contracts";
import type { EngineFailure } from "#src/backend/engine/engine-failure";

/** One finished node's output, with the id of the node that produced it. */
export type NodeOutputInGraphOrder = NodeOutputs[string] & { nodeId: string };

/** Key a node's output is stored and looked up under. */
export function outputKey(nodeId: string): string {
  return nodeId;
}

function writeNodeValue<T>(
  values: Record<string, T>,
  nodeId: string,
  value: T
) {
  // Keep every id as an enumerable own key, including `__proto__`.
  Object.defineProperty(values, outputKey(nodeId), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/**
 * Which of a node's outgoing edges the run follows.
 *
 * `all` is every edge, which is what an ordinary action node fans out along. A
 * Condition node follows the branch it picked, the Lifecycle Node one named
 * outlet, and an Event Split the outlet naming the Event the run arrived on: an
 * edge that names none of them is followed by no run, because the only other way
 * to bind it is render order.
 */
export type TraversalRoute =
  | { kind: "all" }
  | { kind: "condition"; branch: ConditionBranch }
  | { kind: "outlet"; outlet: LifecycleOutlet }
  | { kind: "event"; eventName: string | null };

/**
 * The Arriving Event one branch carries: the Event that put the branch where it
 * is, or null where nothing named one, and the payload the entry node reads as
 * on that branch.
 */
export type Arrival = { eventName: string | null; payload: JsonObject };

/** The arrival below a Wait that timed out and continued, which names none. */
export const NO_ARRIVAL: Arrival = { eventName: null, payload: {} };

/**
 * Identifies an edge by its endpoints and source outlet, so a released edge is
 * still found when a Migration recreates it under another id.
 */
function releasedEdgeKey(edge: WorkflowEdge): string {
  return JSON.stringify([edge.source, edge.target, edge.sourceHandle ?? null]);
}

export class Traversal {
  private readonly nodeOutputs: NodeOutputs = {};
  private readonly nodeResults: Record<string, ExecutionResult> = {};

  private readonly nodes: readonly WorkflowNode[];
  private readonly nodeMap: Map<string, WorkflowNode>;
  private readonly edgesBySource = new Map<string, WorkflowEdge[]>();
  private readonly edgesByTarget = new Map<string, WorkflowEdge[]>();
  private readonly completedNodes = new Set<string>();
  private readonly inProgressNodes = new Set<string>();
  private readonly parkedNodes = new Set<string>();
  /**
   * Every released edge, by `releasedEdgeKey`, with the Arriving Event the
   * branch carries along it.
   */
  private readonly downstreamReadyEdges = new Map<string, Arrival>();
  /** What the entry nodes hand on: the Start Event and its payload. */
  private readonly startArrival: Arrival;
  private readonly entryNodes: readonly WorkflowNode[];

  constructor(
    nodes: readonly WorkflowNode[],
    edges: readonly WorkflowEdge[],
    startArrival: Arrival = NO_ARRIVAL
  ) {
    this.nodes = nodes;
    this.startArrival = startArrival;
    this.nodeMap = new Map(nodes.map((node) => [node.id, node]));

    for (const edge of edges) {
      const sourceEdges = this.edgesBySource.get(edge.source) || [];
      sourceEdges.push(edge);
      this.edgesBySource.set(edge.source, sourceEdges);

      const targetEdges = this.edgesByTarget.get(edge.target) || [];
      targetEdges.push(edge);
      this.edgesByTarget.set(edge.target, targetEdges);
    }

    this.entryNodes = nodes.filter(
      (node) =>
        isLifecycleNode(node) && this.predecessorIds(node.id).length === 0
    );
  }

  /**
   * Every finished node's output, which templates and CEL conditions read.
   *
   * Read-only to everyone outside, so `markCompleted` stays the only way a
   * node's output is written and the run's state has one author. A node reads
   * them through `outputsFor`, which puts its branch's arrival in place of the
   * entry node's output.
   */
  get outputs(): Readonly<NodeOutputs> {
    return this.nodeOutputs;
  }

  /**
   * The Arriving Event of the branch a node sits on: the one carried along its
   * incoming edges, and the Start Event for an entry node. A node joining
   * branches that carry different arrivals takes the one on its incoming edge
   * listed first in the graph's edges, so a pass and its replay agree.
   */
  arrivalOf(nodeId: string): Arrival {
    for (const edge of this.edgesByTarget.get(nodeId) ?? []) {
      const arrival = this.downstreamReadyEdges.get(releasedEdgeKey(edge));
      if (arrival !== undefined) {
        return arrival;
      }
    }
    return this.startArrival;
  }

  /**
   * The node outputs as one node reads them: every finished node's output,
   * with each entry node's output replaced by the payload of the Arriving
   * Event on this node's branch. That is how a node below a Wait addresses the
   * Event that woke it through the entry node, while a parallel branch keeps
   * its own.
   */
  outputsFor(nodeId: string): Readonly<NodeOutputs> {
    // Copying the descriptors keeps an own key named `__proto__`.
    const outputs: NodeOutputs = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(this.nodeOutputs)
    );
    const { payload } = this.arrivalOf(nodeId);
    for (const entryNode of this.entryNodes) {
      writeNodeValue<NodeOutputs[string]>(outputs, entryNode.id, {
        label: entryNode.data.label || entryNode.id,
        data: payload,
      });
    }
    return outputs;
  }

  /**
   * `outputsFor` in the graph's node order, each beside the id of the node
   * that produced it. A pass and its replay finish nodes in different orders,
   * and this order is the same for both.
   */
  outputsInGraphOrder(nodeId: string): NodeOutputInGraphOrder[] {
    const outputs = this.outputsFor(nodeId);
    return this.nodes.flatMap((node) => {
      const output = Object.hasOwn(outputs, outputKey(node.id))
        ? outputs[outputKey(node.id)]
        : undefined;
      return output === undefined ? [] : [{ nodeId: node.id, ...output }];
    });
  }

  /** What each node that produced an outcome left, keyed by node id. */
  get results(): Readonly<Record<string, ExecutionResult>> {
    return this.nodeResults;
  }

  getNode(nodeId: string): WorkflowNode | undefined {
    return this.nodeMap.get(nodeId);
  }

  isCompleted(nodeId: string): boolean {
    return this.completedNodes.has(nodeId);
  }

  /** Every node with an edge into this one. */
  predecessorIds(nodeId: string): string[] {
    return (this.edgesByTarget.get(nodeId) ?? []).map((edge) => edge.source);
  }

  /**
   * Whether every predecessor has released this node.
   *
   * A root (no incoming edges) is ready when the scheduler names it. An
   * An AND-join waits until each incoming edge was selected and released by its
   * predecessor. Completing a Condition does not release its unselected outlet.
   */
  isReadyToRun(nodeId: string): boolean {
    return (this.edgesByTarget.get(nodeId) ?? []).every((edge) =>
      this.downstreamReadyEdges.has(releasedEdgeKey(edge))
    );
  }

  /**
   * Runs `work` with the node marked as running, and answers `false` for a node
   * already running or completed, so a node scheduled twice executes once. The mark comes
   * off however the work ends, because a node whose work threw is no longer
   * running.
   */
  withNodeInProgress<E, R>(
    nodeId: string,
    work: () => Effect.Effect<void, E, R>
  ): Effect.Effect<boolean, E, R> {
    const acquire = Effect.sync(() => {
      if (this.completedNodes.has(nodeId) || this.inProgressNodes.has(nodeId)) {
        return false;
      }

      this.inProgressNodes.add(nodeId);
      return true;
    });

    return Effect.flatMap(acquire, (acquired) => {
      if (!acquired) {
        return Effect.succeed(false);
      }

      const release = Effect.sync(() => this.inProgressNodes.delete(nodeId));
      return Effect.matchCauseEffect(Effect.suspend(work), {
        onFailure: (cause) =>
          Effect.gen(function* () {
            yield* release;
            return yield* Effect.failCause(cause);
          }),
        onSuccess: () => Effect.as(release, true),
      });
    });
  }

  /** The nodes this one hands on to, along the edges the route names. */
  private nextEdges(
    nodeId: string,
    route: TraversalRoute
  ): readonly WorkflowEdge[] {
    const edges = this.edgesBySource.get(nodeId) ?? [];

    if (route.kind === "condition") {
      return edges.filter(
        (edge) => normalizeConditionBranch(edge.sourceHandle) === route.branch
      );
    }

    if (route.kind === "outlet") {
      return edges.filter((edge) => edge.sourceHandle === route.outlet);
    }

    if (route.kind === "event") {
      // A run with no Event -- a manual start, the execute route -- matches no
      // outlet, so it stops at the split rather than taking every branch.
      return route.eventName === null
        ? []
        : edges.filter(
            (edge) =>
              eventSplitOutletEvent(edge.sourceHandle) === route.eventName
          );
    }

    return edges;
  }

  /**
   * Lets the nodes below this one run, carrying `arrival` along each released
   * edge; left out, the branch carries the arrival it reached this node with.
   * Called only where the run is going down that path: a node that failed,
   * halted its branch, was never configured, or is a Condition whose
   * expression produced no boolean releases nothing, and everything behind it
   * stays unscheduled for the life of the run.
   */
  markReadyForDownstream(
    nodeId: string,
    route: TraversalRoute,
    arrival: Arrival = this.arrivalOf(nodeId)
  ): string[] {
    const edges = this.nextEdges(nodeId, route);
    for (const edge of edges) {
      this.downstreamReadyEdges.set(releasedEdgeKey(edge), arrival);
    }
    return edges.map((edge) => edge.target);
  }

  /**
   * Records an outcome for a node that produced no output, so the run's verdict
   * counts it without downstream templates being able to address it.
   */
  recordResult(nodeId: string, result: ExecutionResult) {
    writeNodeValue(this.nodeResults, nodeId, result);
  }

  /**
   * Records a node's outcome and closes it. The output is left out by a node
   * whose work threw, which has an outcome but nothing to hand on.
   */
  markCompleted(
    nodeId: string,
    result: ExecutionResult,
    output?: NodeOutputs[string]
  ) {
    writeNodeValue(this.nodeResults, nodeId, result);
    if (output) {
      writeNodeValue(this.nodeOutputs, nodeId, output);
    }
    this.completedNodes.add(nodeId);
  }

  /**
   * Records a Wait whose park the runtime has not resolved. The node has no
   * result and releases nothing.
   */
  markParked(nodeId: string) {
    this.parkedNodes.add(nodeId);
  }

  /** How many Waits this pass of the body left parked. */
  get openParkCount(): number {
    return this.parkedNodes.size;
  }

  /**
   * The entry nodes of this graph, whose output a node reads as the payload of
   * its branch's Arriving Event.
   */
  get lifecycleNodes(): readonly WorkflowNode[] {
    return this.entryNodes;
  }

  get resultCount(): number {
    return Object.keys(this.results).length;
  }

  /** The typed failure the run ended with, taken from its first failed node. */
  firstFailure(): EngineFailure | undefined {
    return executionFailure(
      Object.values(this.results).find((result) => !result.success)
    );
  }

  /**
   * The payload a finished run answers with: the first output a leaf node
   * produced, falling back to any node's. Both passes go in node-id order, so
   * two runs of one graph answer alike whatever order the nodes finished in.
   */
  deterministicTerminalOutput(): unknown {
    // A node id is a generated UUIDv7, so code-unit order is enough for a
    // deterministic result. `compareText` is for text a person reads.
    const terminalNodeIds = this.nodes
      .filter((node) => (this.edgesBySource.get(node.id)?.length ?? 0) === 0)
      .map((node) => node.id)
      .toSorted();

    for (const nodeId of terminalNodeIds) {
      const output = executionData(this.results[nodeId]);
      if (output !== undefined) {
        return output;
      }
    }

    const resultKeys = Object.keys(this.results).toSorted();
    for (const nodeId of resultKeys) {
      const output = executionData(this.results[nodeId]);
      if (output !== undefined) {
        return output;
      }
    }

    return undefined;
  }
}
