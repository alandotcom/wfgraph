/**
 * The path one run took through the graph it pinned, read from its recorded
 * executions. A Condition leaves by the branch its recorded answer names, an
 * Event Split by the outlet of the Event it recorded, and every other node by
 * each connection whose target the run reached. While the run is in progress,
 * a connection the run may still take is left undecided.
 */

import { normalizeConditionBranch } from "@wfgraph/shared/conditions/condition-branch";
import { isConditionNode } from "@wfgraph/shared/graph/node-config";
import { unwrapStepOutput } from "@wfgraph/shared/graph/node-references";
import {
  eventSplitOutletEvent,
  isEventSplitNode,
} from "@wfgraph/shared/lifecycle/event-split";
import { isJsonObject, readJsonValue } from "@wfgraph/shared/types/json";
import { type ExecutionLog, isRunInProgress } from "#src/lib/execution-logs";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

/** Whether the run went along a connection or left a node by an outlet. */
export type RunPathMark = "taken" | "not-taken";

/**
 * How a node the run reached, or can no longer reach, left. `outlets` holds the
 * Condition branches (`true`, `false`) or the Event names an Event Split left
 * by, or `every` for a node that releases each of its connections. `final` is
 * false while an execution of the node is unfinished in a run in progress, so
 * an outlet missing from `outlets` may still be taken.
 */
export type NodeExit = {
  kind: "condition" | "event-split" | "step";
  outlets: "every" | ReadonlySet<string>;
  final: boolean;
};

export type RunPath = {
  /**
   * The mark of each stored connection, by edge id. A connection with no mark
   * is undecided, which happens only while the run is in progress.
   */
  edges: ReadonlyMap<string, RunPathMark>;
  /** How each node left, by node id. A node with no exit is undecided. */
  exits: ReadonlyMap<string, NodeExit>;
};

/** The Condition answer a recorded output holds, or null for none. */
function recordedConditionAnswer(output: unknown): string | null {
  const value = unwrapStepOutput(readJsonValue(output));
  return isJsonObject(value) && typeof value.condition === "boolean"
    ? String(value.condition)
    : null;
}

/** The Event an Event Split's recorded output routed by, or null for none. */
function recordedSplitEvent(output: unknown): string | null {
  const value = unwrapStepOutput(readJsonValue(output));
  return isJsonObject(value) && typeof value.event === "string"
    ? value.event
    : null;
}

/**
 * Whether the outlet `handle` of a node that left as `exit` is one the run
 * took. A Condition's handle names its branch and an Event Split's names its
 * Event; any other node's handles are all taken once it released them.
 */
function outletTaken(exit: NodeExit, handle: string | null | undefined) {
  if (exit.outlets === "every") {
    return true;
  }
  const outlet =
    exit.kind === "condition"
      ? normalizeConditionBranch(handle)
      : exit.kind === "event-split"
        ? eventSplitOutletEvent(handle)
        : null;
  return outlet !== null && exit.outlets.has(outlet);
}

/**
 * The mark of the outlet `handle` of the node `nodeId`, or null while it is
 * undecided. A Condition's unconnected branch and a "Path ends" stub read it.
 */
export function runPathOutletMark(
  path: RunPath,
  nodeId: string,
  handle: string | null | undefined
): RunPathMark | null {
  const exit = path.exits.get(nodeId);
  if (exit === undefined) {
    return null;
  }
  if (outletTaken(exit, handle)) {
    return "taken";
  }
  return exit.final ? "not-taken" : null;
}

/**
 * The path the run took through `nodes` and `edges`, the graph it pinned, as
 * its `logs` record it. `executionStatus` says whether the run has ended, which
 * turns every connection it did not take into one it never will.
 */
export function runPath(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  logs: readonly Pick<ExecutionLog, "nodeId" | "status" | "output">[];
  executionStatus: string;
}): RunPath {
  const ended = !isRunInProgress(input.executionStatus);
  // Maps, because node ids are text the builder chose.
  const logsByNode = Map.groupBy(input.logs, (log) => log.nodeId);
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const incomingByNode = Map.groupBy(input.edges, (edge) => edge.target);
  const exits = new Map<string, NodeExit | null>();
  const marks = new Map<string, RunPathMark | null>();

  const kindOf = (nodeId: string): NodeExit["kind"] => {
    const node = nodeById.get(nodeId);
    return isConditionNode(node)
      ? "condition"
      : isEventSplitNode(node)
        ? "event-split"
        : "step";
  };

  const exitOf = (nodeId: string): NodeExit | null => {
    if (exits.has(nodeId)) {
      return exits.get(nodeId) ?? null;
    }
    // Marked undecided while it is worked out, so a cycle in a malformed
    // graph ends the walk instead of recursing forever.
    exits.set(nodeId, null);
    const exit = computeExit(nodeId);
    exits.set(nodeId, exit);
    return exit;
  };

  const computeExit = (nodeId: string): NodeExit | null => {
    const kind = kindOf(nodeId);
    const logs = logsByNode.get(nodeId) ?? [];
    if (logs.length === 0) {
      // A node the run never reached left by nothing once the run ended, or
      // once every connection into it is one the run did not take.
      const incoming = incomingByNode.get(nodeId) ?? [];
      const unreachable =
        ended ||
        (incoming.length > 0 &&
          incoming.every((edge) => markOf(edge) === "not-taken"));
      return unreachable ? { kind, outlets: new Set(), final: true } : null;
    }
    const final =
      ended ||
      logs.every((log) => log.status !== "pending" && log.status !== "running");
    const succeeded = logs.filter((log) => log.status === "success");
    if (kind === "step") {
      return {
        kind,
        outlets: succeeded.length > 0 ? "every" : new Set(),
        final,
      };
    }
    const read =
      kind === "condition" ? recordedConditionAnswer : recordedSplitEvent;
    const outlets = new Set(
      succeeded.flatMap((log) => {
        const outlet = read(log.output);
        return outlet === null ? [] : [outlet];
      })
    );
    return { kind, outlets, final };
  };

  const markOf = (edge: WorkflowEdge): RunPathMark | null => {
    if (marks.has(edge.id)) {
      return marks.get(edge.id) ?? null;
    }
    marks.set(edge.id, null);
    const mark = computeMark(edge);
    marks.set(edge.id, mark);
    return mark;
  };

  const computeMark = (edge: WorkflowEdge): RunPathMark | null => {
    const exit = exitOf(edge.source);
    if (exit === null) {
      return null;
    }
    if (!outletTaken(exit, edge.sourceHandle)) {
      return exit.final ? "not-taken" : null;
    }
    // A Condition or an Event Split chose this outlet, which is the path even
    // before its target starts. Any other node released every connection, and
    // one is taken once the run reached its target, since a node can still
    // halt its branch after it succeeds.
    if (exit.kind !== "step" || logsByNode.has(edge.target)) {
      return "taken";
    }
    return ended ? "not-taken" : null;
  };

  for (const edge of input.edges) {
    markOf(edge);
  }
  for (const node of input.nodes) {
    exitOf(node.id);
  }
  return {
    edges: definedEntries(marks),
    exits: definedEntries(exits),
  };
}

/** `map` without the entries holding null. */
function definedEntries<V>(map: ReadonlyMap<string, V | null>) {
  return new Map(
    [...map].flatMap(([key, value]) =>
      value === null ? [] : [[key, value] as const]
    )
  );
}
