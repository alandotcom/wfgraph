/**
 * The recorded evidence of one node in one run, built from the reads the Runs
 * surface already holds. Every function is pure. A Group frame is organizational
 * and never has evidence, so no node id here ever names one.
 */

import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { isJsonObject, readJsonValue } from "@wfgraph/shared/types/json";
import { isBlank } from "@wfgraph/shared/types/string";
import { sortBy } from "es-toolkit/array";
import {
  applyExecutionStatusToLogs,
  type ExecutionEvent,
  type ExecutionLog,
  type ExecutionWait,
  isRunInProgress,
  type WorkflowExecution,
} from "#src/lib/execution-logs";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  type CanvasSelection,
  type ChosenRunExecution,
  singleSelectedNodeId,
} from "#src/lib/workflow-navigation-state";

/**
 * Whether the graph a run pinned is on the canvas: `ready` once it is,
 * `loading` while it is read, and `unavailable` when it cannot be read.
 */
export type PinnedGraphState = "ready" | "loading" | "unavailable";

/**
 * The node whose evidence a run address shows, or null. It is the node the
 * selection holds alone, unless that node is a Group frame. With nothing
 * selected it is the node of the chosen execution, which covers a node the
 * canvas cannot select, such as one the pinned graph lacks.
 */
export function runEvidenceNodeId(input: {
  selection: CanvasSelection;
  chosenExecution: ChosenRunExecution | null;
  nodes: readonly Pick<WorkflowNode, "id" | "data">[];
}): string | null {
  const { selection, chosenExecution, nodes } = input;
  const selectedId = singleSelectedNodeId(selection);
  if (selectedId !== null) {
    return isGroupNode(nodes.find((node) => node.id === selectedId))
      ? null
      : selectedId;
  }
  return selection.nodeIds.length === 0 && selection.edgeIds.length === 0
    ? (chosenExecution?.nodeId ?? null)
    : null;
}

/** A run's logs in the order they started, with the run's status applied. */
export function orderedRunLogs(
  logs: readonly ExecutionLog[],
  executionStatus: string
): ExecutionLog[] {
  return sortBy(applyExecutionStatusToLogs([...logs], executionStatus), [
    (log) => log.startedAt.getTime(),
  ]);
}

/**
 * The execution shown for a node: the chosen execution when it belongs to the
 * node and is still recorded, and otherwise the latest. Null for a node that
 * never ran. `logs` is in start order.
 */
export function shownExecution(input: {
  logs: readonly ExecutionLog[];
  nodeId: string;
  chosenExecution: ChosenRunExecution | null;
}): ExecutionLog | null {
  const executions = input.logs.filter((log) => log.nodeId === input.nodeId);
  const chosen =
    input.chosenExecution?.nodeId === input.nodeId
      ? executions.find((log) => log.id === input.chosenExecution?.logId)
      : undefined;
  return chosen ?? executions.at(-1) ?? null;
}

/**
 * How a run node is named: its label in the pinned graph, then the name its
 * latest log recorded, then "Step".
 */
export function runNodeTitle(input: {
  nodeId: string;
  nodes: readonly Pick<WorkflowNode, "id" | "data">[];
  logs: readonly ExecutionLog[];
}): string {
  const label = input.nodes.find((node) => node.id === input.nodeId)?.data
    .label;
  if (label !== undefined && !isBlank(label)) {
    return label;
  }
  const logged = input.logs.findLast((log) => log.nodeId === input.nodeId);
  return logged && !isBlank(logged.nodeName) ? logged.nodeName : "Step";
}

/** The node an audit event names in its metadata, or null. */
function eventNodeId(event: ExecutionEvent): string | null {
  const metadata = readJsonValue(event.metadata);
  return isJsonObject(metadata) && typeof metadata.nodeId === "string"
    ? metadata.nodeId
    : null;
}

export type RunNodeEvidence = {
  nodeId: string;
  title: string;
  /** The node type the pinned graph or the latest log records. */
  nodeType: string;
  /**
   * Every recorded execution of the node, in start order: one run-log row each
   * time the run reached the node. Retries inside one execution rewrite that
   * execution's row, so its status is the final outcome of those retries.
   */
  executions: readonly ExecutionLog[];
  /** The execution shown, or null for a node that never ran. */
  shownExecution: ExecutionLog | null;
  pinnedGraph: PinnedGraphState;
  /** Whether the pinned graph is on the canvas and does not hold the node. */
  removed: boolean;
  /** The node's configuration in the pinned graph, when the graph holds it. */
  config: Readonly<Record<string, unknown>> | null;
  /** The waits the run is parked on at this node, while the run is in progress. */
  waits: readonly ExecutionWait[];
  /** The run's audit events that name this node, oldest first. */
  activity: readonly ExecutionEvent[];
  /** The run's cancellation event, when the shown execution was cancelled. */
  cancellation: ExecutionEvent | null;
  /** Whether the run is still in progress, so its reads keep polling. */
  inProgress: boolean;
};

/** The evidence of `nodeId` in the run the reads describe. */
export function buildRunNodeEvidence(input: {
  nodeId: string;
  execution: WorkflowExecution;
  logs: readonly ExecutionLog[];
  waits: readonly ExecutionWait[];
  events: readonly ExecutionEvent[];
  nodes: readonly WorkflowNode[];
  pinnedGraph: PinnedGraphState;
  chosenExecution: ChosenRunExecution | null;
}): RunNodeEvidence {
  const { nodeId, execution, nodes } = input;
  const logs = orderedRunLogs(input.logs, execution.status);
  const executions = logs.filter((log) => log.nodeId === nodeId);
  const shown = shownExecution({
    logs,
    nodeId,
    chosenExecution: input.chosenExecution,
  });
  const node = nodes.find((item) => item.id === nodeId);
  const inProgress = isRunInProgress(execution.status);
  return {
    nodeId,
    title: runNodeTitle({ nodeId, nodes, logs }),
    nodeType: executions.at(-1)?.nodeType ?? node?.data.type ?? "action",
    executions,
    shownExecution: shown,
    pinnedGraph: input.pinnedGraph,
    removed: input.pinnedGraph === "ready" && node === undefined,
    config: node?.data.config ?? null,
    waits: inProgress
      ? input.waits.filter((wait) => wait.nodeId === nodeId)
      : [],
    activity: sortBy(
      input.events.filter((event) => eventNodeId(event) === nodeId),
      [(event) => event.createdAt.getTime()]
    ),
    cancellation:
      shown?.status === "cancelled"
        ? (input.events.findLast(
            (event) => event.eventType === "run_cancelled"
          ) ?? null)
        : null,
    inProgress,
  };
}
