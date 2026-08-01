/**
 * The traversal's own state: the graph indexed for lookup, what each node left
 * behind, and how far round the graph the run has got.
 *
 * Holding it in one value is what lets `markReadyForDownstream` state the rule a
 * scheduler has to follow. The scheduler itself is in `core.ts`.
 */

import { normalizeConditionBranch } from "@rova/shared/conditions/condition-branch";
import type {
  ConditionBranch,
  WorkflowEdge,
  WorkflowNode,
} from "@rova/shared/graph/types";
import { eventSplitOutletEvent } from "@rova/shared/lifecycle/event-split";
import type { LifecycleOutlet } from "@rova/shared/lifecycle/lifecycle-outlets";
import {
  type ExecutionResult,
  executionData,
  executionError,
  type NodeOutputs,
} from "#src/backend/engine/contracts";

/** Key a node's output is stored and looked up under. */
export function outputKey(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9]/g, "_");
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
  private readonly edgesByTarget = new Map<string, string[]>();
  private readonly completedNodes = new Set<string>();
  private readonly inProgressNodes = new Set<string>();
  private readonly downstreamReadyNodes = new Set<string>();

  constructor(nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[]) {
    this.nodes = nodes;
    this.nodeMap = new Map(nodes.map((node) => [node.id, node]));

    for (const edge of edges) {
      const sourceEdges = this.edgesBySource.get(edge.source) || [];
      sourceEdges.push(edge);
      this.edgesBySource.set(edge.source, sourceEdges);

      const sources = this.edgesByTarget.get(edge.target) || [];
      sources.push(edge.source);
      this.edgesByTarget.set(edge.target, sources);
    }
  }

  /**
   * Every finished node's output, which templates and CEL conditions read.
   *
   * Read-only to everyone outside, so `setOutput` and `markCompleted` stay the
   * only way a node's output is written and the run's state has one author.
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

  /**
   * Runs `work` with the node marked as running, and answers `false` for a node
   * already running, so a node scheduled twice executes once. The mark comes off
   * however the work ends, since a node whose work threw is no longer running.
   */
  async withNodeInProgress(
    nodeId: string,
    work: () => Promise<void>
  ): Promise<boolean> {
    if (this.inProgressNodes.has(nodeId)) {
      return false;
    }

    this.inProgressNodes.add(nodeId);
    try {
      await work();
    } finally {
      this.inProgressNodes.delete(nodeId);
    }

    return true;
  }

  /**
   * The nodes an incoming edge points from, and which of those have not yet
   * released this one. A node with anything missing is not ready to run, and the
   * source that is still outstanding schedules it when it releases.
   */
  dependenciesOf(nodeId: string): {
    dependencies: string[];
    missing: string[];
  } {
    const dependencies = this.edgesByTarget.get(nodeId) ?? [];
    return {
      dependencies,
      missing: dependencies.filter(
        (dependency) => !this.downstreamReadyNodes.has(dependency)
      ),
    };
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
      this.nodeOutputs[outputKey(nodeId)] = output;
    }
    this.completedNodes.add(nodeId);
  }

  /** Writes a node's output without closing the node. */
  setOutput(nodeId: string, output: NodeOutputs[string]) {
    this.nodeOutputs[outputKey(nodeId)] = output;
  }

  get resultCount(): number {
    return Object.keys(this.results).length;
  }

  allSucceeded(): boolean {
    return Object.values(this.results).every((result) => result.success);
  }

  /** The sentence the run failed with, taken from the first node that failed. */
  firstFailureMessage(): string | undefined {
    return executionError(
      Object.values(this.results).find((result) => !result.success)
    );
  }

  /**
   * The payload a finished run answers with: the first output a leaf node
   * produced, falling back to any node's. Both passes go in node-id order, so
   * two runs of one graph answer alike whatever order the nodes finished in.
   */
  deterministicTerminalOutput(): unknown {
    const terminalNodeIds = this.nodes
      .filter((node) => (this.edgesBySource.get(node.id)?.length ?? 0) === 0)
      .map((node) => node.id)
      .toSorted((a, b) => a.localeCompare(b));

    for (const nodeId of terminalNodeIds) {
      const output = executionData(this.results[nodeId]);
      if (output !== undefined) {
        return output;
      }
    }

    const resultKeys = Object.keys(this.results).toSorted((a, b) =>
      a.localeCompare(b)
    );
    for (const nodeId of resultKeys) {
      const output = executionData(this.results[nodeId]);
      if (output !== undefined) {
        return output;
      }
    }

    return undefined;
  }
}
