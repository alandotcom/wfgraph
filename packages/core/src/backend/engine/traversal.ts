/**
 * The traversal's own state: the graph indexed for lookup, what each node left
 * behind, and how far round the graph the run has got.
 *
 * Holding it in one value is what lets `markReadyForDownstream` state the rule a
 * scheduler has to follow. The scheduler itself is in `core.ts`.
 *
 * A node with one predecessor runs as soon as that node releases it. A node
 * with several is an AND-join: `isReadyToRun` is true only once every
 * predecessor has released, which is how two lookups can both feed the next
 * step. Saving refuses joins that would hang (Wait on an arm, exclusive
 * branches, Started↔Canceled).
 */

import { omit } from "es-toolkit/object";
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
import type { BranchRunResult } from "#src/backend/engine/branch";
import {
  type ExecutionResult,
  executionData,
  executionFailure,
  type NodeOutputs,
} from "#src/backend/engine/contracts";
import type { EngineFailure } from "#src/backend/engine/engine-failure";

/** Key a node's output is stored and looked up under. */
export function outputKey(nodeId: string): string {
  return nodeId;
}

function writeOutput(
  outputs: NodeOutputs,
  nodeId: string,
  output: NodeOutputs[string]
) {
  Object.defineProperty(outputs, outputKey(nodeId), {
    configurable: true,
    enumerable: true,
    value: output,
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

export class Traversal {
  private readonly nodeOutputs: NodeOutputs = {};
  private readonly nodeResults: Record<string, ExecutionResult> = {};

  private readonly nodes: readonly WorkflowNode[];
  private readonly nodeMap: Map<string, WorkflowNode>;
  private readonly edgesBySource = new Map<string, WorkflowEdge[]>();
  private readonly edgesByTarget = new Map<string, WorkflowEdge[]>();
  private readonly completedNodes = new Set<string>();
  private readonly inheritedOutputKeys = new Set<string>();
  private readonly inProgressNodes = new Set<string>();
  private readonly downstreamReadyNodes = new Set<string>();

  constructor(nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[]) {
    this.nodes = nodes;
    this.nodeMap = new Map(nodes.map((node) => [node.id, node]));

    for (const edge of edges) {
      const sourceEdges = this.edgesBySource.get(edge.source) || [];
      sourceEdges.push(edge);
      this.edgesBySource.set(edge.source, sourceEdges);

      const targetEdges = this.edgesByTarget.get(edge.target) || [];
      targetEdges.push(edge);
      this.edgesByTarget.set(edge.target, targetEdges);
    }
  }

  /**
   * Every finished node's output, which templates and CEL conditions read.
   *
   * Read-only to everyone outside, so `setOutput`, `setOwnOutput`, and
   * `markCompleted` stay the only way a node's output is written and the run's
   * state has one author.
   */
  get outputs(): Readonly<NodeOutputs> {
    return this.nodeOutputs;
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
   * AND-join waits until each predecessor has called `markReadyForDownstream`.
   */
  isReadyToRun(nodeId: string): boolean {
    const predecessors = this.predecessorIds(nodeId);
    if (predecessors.length === 0) {
      return true;
    }
    return predecessors.every((predecessorId) =>
      this.downstreamReadyNodes.has(predecessorId)
    );
  }

  /**
   * Runs `work` with the node marked as running, and answers `false` for a node
   * already running, so a node scheduled twice executes once. The mark comes
   * off however the work ends, because a node whose work threw is no longer
   * running.
   */
  withNodeInProgress<E, R>(
    nodeId: string,
    work: () => Effect.Effect<void, E, R>
  ): Effect.Effect<boolean, E, R> {
    const acquire = Effect.sync(() => {
      if (this.inProgressNodes.has(nodeId)) {
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
  nextNodes(nodeId: string, route: TraversalRoute): string[] {
    const edges = this.edgesBySource.get(nodeId) ?? [];

    if (route.kind === "condition") {
      return edges
        .filter(
          (edge) => normalizeConditionBranch(edge.sourceHandle) === route.branch
        )
        .map((edge) => edge.target);
    }

    if (route.kind === "outlet") {
      return edges
        .filter((edge) => edge.sourceHandle === route.outlet)
        .map((edge) => edge.target);
    }

    if (route.kind === "event") {
      // A run with no Event -- a manual start, the execute route -- matches no
      // outlet, so it stops at the split rather than taking every branch.
      return route.eventName === null
        ? []
        : edges
            .filter(
              (edge) =>
                eventSplitOutletEvent(edge.sourceHandle) === route.eventName
            )
            .map((edge) => edge.target);
    }

    return edges.map((edge) => edge.target);
  }

  /**
   * Lets the nodes below this one run. Called only where the run is going down
   * that path: a node that failed, halted its branch, was never configured, or
   * is a Condition whose expression produced no boolean releases nothing, and
   * everything behind it stays unscheduled for the life of the run.
   */
  markReadyForDownstream(nodeId: string) {
    this.downstreamReadyNodes.add(nodeId);
  }

  /**
   * Records an outcome for a node that produced no output, so the run's verdict
   * counts it without downstream templates being able to address it.
   */
  recordResult(nodeId: string, result: ExecutionResult) {
    this.nodeResults[nodeId] = result;
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
    this.nodeResults[nodeId] = result;
    if (output) {
      writeOutput(this.nodeOutputs, nodeId, output);
    }
    this.completedNodes.add(nodeId);
  }

  /** Writes a node's output without closing the node. */
  setOutput(nodeId: string, output: NodeOutputs[string]) {
    writeOutput(this.nodeOutputs, nodeId, output);
  }

  /**
   * Writes a node's output as this run's own, even when the node was inherited.
   *
   * A branch run inherits the entry node's Start Event payload, then an
   * event-mode Wait overwrites it with the Event that woke the Wait. Without
   * taking ownership, `ownOutputs` would omit the write and the parent run
   * would keep the payload it already has.
   */
  setOwnOutput(nodeId: string, output: NodeOutputs[string]) {
    writeOutput(this.nodeOutputs, nodeId, output);
    this.inheritedOutputKeys.delete(outputKey(nodeId));
  }

  /**
   * The entry nodes of this graph, whose output is the Arriving Event payload.
   */
  get lifecycleNodes(): readonly WorkflowNode[] {
    return this.nodes.filter(
      (node) =>
        isLifecycleNode(node) && this.predecessorIds(node.id).length === 0
    );
  }

  /**
   * Records a node this run inherited rather than ran, which is how a branch run
   * sees the graph above the node it starts at.
   *
   * The node is closed, so this run never walks it again, and its output is
   * readable by the templates behind it. Two things it does not get. No result:
   * what this run answers for is what it did itself. And no release, which is
   * carried separately, because a node that halted its branch has an output and
   * released nothing, and the two cannot be told apart from a stored row.
   */
  inheritCompleted(nodeId: string, output: NodeOutputs[string]) {
    const key = outputKey(nodeId);
    writeOutput(this.nodeOutputs, nodeId, output);
    this.inheritedOutputKeys.add(key);
    this.completedNodes.add(nodeId);
  }

  /** Every node that has released what is below it, for a branch run to start from. */
  get releasedNodeIds(): string[] {
    return [...this.downstreamReadyNodes];
  }

  /**
   * The outputs this run produced, which is what it hands back to the run that
   * started it. What it inherited is left out: that run has those already, and
   * an HTTP Request step's response body sent back up is the cost the store read
   * exists to avoid.
   */
  get ownOutputs(): NodeOutputs {
    return omit(this.nodeOutputs, [...this.inheritedOutputKeys]);
  }

  /**
   * Takes on what a branch run did, so the run that handed the branch off
   * answers for those nodes as if it had walked them.
   */
  absorbBranch(branch: BranchRunResult) {
    for (const [nodeId, result] of Object.entries(branch.results)) {
      this.nodeResults[nodeId] = result;
    }
    for (const [nodeId, output] of Object.entries(branch.outputs)) {
      writeOutput(this.nodeOutputs, nodeId, output);
    }
  }

  get resultCount(): number {
    return Object.keys(this.results).length;
  }

  allSucceeded(): boolean {
    return Object.values(this.results).every((result) => result.success);
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
    // Node ids are nanoids ordered for a deterministic result, not for a person
    // to read, so plain code-unit order is the honest comparator here (es-toolkit's
    // sortBy takes only arrays of objects, which a bare id string is not).
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
