import { WRITE_TOOL_NAMES } from "@wfgraph/agent/toolkit";
import type { AgentDocument } from "@wfgraph/agent/document";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import { eventSplitOutletEvent } from "@wfgraph/shared/lifecycle/event-split";
import { isJsonObject, type JsonValue } from "@wfgraph/shared/types/json";
import type { DeterministicAssessment } from "#src/agent/assessment";
import type {
  AgentTrajectory,
  AgentTrajectoryToolCall,
} from "#src/agent/trajectory";

function actionId(call: AgentTrajectoryToolCall): string | undefined {
  const value = call.input.actionId;
  return typeof value === "string" ? value : undefined;
}

function succeededBefore(
  calls: readonly AgentTrajectoryToolCall[],
  call: AgentTrajectoryToolCall,
  predicate: (candidate: AgentTrajectoryToolCall) => boolean
): boolean {
  return calls.some(
    (candidate) =>
      candidate.order < call.order &&
      candidate.result !== undefined &&
      !candidate.result.failed &&
      candidate.result.order < call.order &&
      predicate(candidate)
  );
}

function stringsIn(value: JsonValue): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsIn);
  }
  if (isJsonObject(value)) {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

function referenceTokensIn(call: AgentTrajectoryToolCall): string[] {
  return stringsIn(call.input).flatMap((value) =>
    findTemplateTokens(value).map((token) => token.raw)
  );
}

function referenceTokensReturnedBy(call: AgentTrajectoryToolCall): string[] {
  const result = call.result?.result;
  if (!isJsonObject(result) || !Array.isArray(result.references)) {
    return [];
  }

  return result.references.flatMap((reference) =>
    isJsonObject(reference) && typeof reference.token === "string"
      ? [reference.token]
      : []
  );
}

function configuredEventNames(call: AgentTrajectoryToolCall): string[] {
  if (call.name === "set_lifecycle_rules") {
    const eventSets = [
      call.input.startEvents,
      call.input.cancelEvents,
      call.input.clearCorrelationPaths,
      call.input.clearEventConnections,
      call.input.clearStartFilters,
      call.input.clearCancelFilters,
    ];
    const eventPatches = [
      call.input.correlationPaths,
      call.input.eventConnections,
      call.input.startFilters,
      call.input.cancelFilters,
    ];
    return [
      ...eventSets.flatMap((value) =>
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : []
      ),
      ...eventPatches.flatMap((value) =>
        Array.isArray(value)
          ? value.flatMap((item) =>
              isJsonObject(item) && typeof item.event === "string"
                ? [item.event]
                : []
            )
          : []
      ),
    ];
  }
  if (call.name === "connect_nodes") {
    const eventName = eventSplitOutletEvent(
      typeof call.input.sourceHandle === "string"
        ? call.input.sourceHandle
        : undefined
    );
    return eventName ? [eventName] : [];
  }
  if (call.name === "insert_node_on_edge") {
    const eventName = eventSplitOutletEvent(
      typeof call.input.outgoingSourceHandle === "string"
        ? call.input.outgoingSourceHandle
        : undefined
    );
    return eventName ? [eventName] : [];
  }
  if (call.name !== "set_wait" || !isJsonObject(call.input.wait)) {
    return [];
  }

  const events = call.input.wait.events;
  return Array.isArray(events)
    ? events.flatMap((subscription) =>
        isJsonObject(subscription) && typeof subscription.event === "string"
          ? [subscription.event]
          : []
      )
    : [];
}

function successfulReadsBefore(
  calls: readonly AgentTrajectoryToolCall[],
  boundary: AgentTrajectoryToolCall
): AgentTrajectoryToolCall[] {
  return calls.filter(
    (candidate) =>
      candidate.name === "read_workflow" &&
      candidate.order < boundary.order &&
      candidate.result !== undefined &&
      !candidate.result.failed &&
      candidate.result.order < boundary.order &&
      isJsonObject(candidate.result.result)
  );
}

function completedPageAxis(
  reads: readonly AgentTrajectoryToolCall[],
  offsetKey: "nodeOffset" | "edgeOffset",
  nextOffsetKey: "nextNodeOffset" | "nextEdgeOffset"
): boolean {
  const pages = new Map<number, JsonValue>();
  for (const read of reads) {
    const offset = read.input[offsetKey];
    if (offset !== undefined && typeof offset !== "number") {
      continue;
    }
    const result = read.result?.result;
    if (isJsonObject(result)) {
      pages.set(offset ?? 0, result[nextOffsetKey]);
    }
  }

  const visited = new Set<number>();
  let offset = 0;
  while (!visited.has(offset)) {
    visited.add(offset);
    if (!pages.has(offset)) {
      return false;
    }
    const nextOffset = pages.get(offset);
    if (nextOffset === undefined) {
      return true;
    }
    if (typeof nextOffset !== "number") {
      return false;
    }
    offset = nextOffset;
  }
  return false;
}

function workflowReadCompletedBefore(
  calls: readonly AgentTrajectoryToolCall[],
  boundary: AgentTrajectoryToolCall
): boolean {
  const reads = successfulReadsBefore(calls, boundary);
  return (
    completedPageAxis(reads, "nodeOffset", "nextNodeOffset") &&
    completedPageAxis(reads, "edgeOffset", "nextEdgeOffset")
  );
}

function nodeActionIds(
  document: AgentDocument,
  calls: readonly AgentTrajectoryToolCall[]
): ReadonlyMap<string, string> {
  const byNodeId = new Map(
    document.nodes.flatMap((node) => {
      const id = actionTypeOf(node);
      return id ? [[node.id, id] as const] : [];
    })
  );

  for (const call of calls) {
    if (
      (call.name === "read_workflow" || call.name === "read_nodes") &&
      call.result !== undefined &&
      !call.result.failed &&
      isJsonObject(call.result.result) &&
      Array.isArray(call.result.result.nodes)
    ) {
      for (const node of call.result.result.nodes) {
        if (
          isJsonObject(node) &&
          typeof node.id === "string" &&
          typeof node.actionType === "string"
        ) {
          byNodeId.set(node.id, node.actionType);
        }
      }
    }

    if (
      (call.name === "add_node" || call.name === "insert_node_on_edge") &&
      call.result !== undefined &&
      !call.result.failed &&
      isJsonObject(call.result.result) &&
      typeof call.result.result.nodeId === "string"
    ) {
      const id = actionId(call);
      if (id) {
        byNodeId.set(call.result.result.nodeId, id);
      }
    }
  }

  return byNodeId;
}

function usedAction(input: {
  readonly call: AgentTrajectoryToolCall;
  readonly actionIdsByNode: ReadonlyMap<string, string>;
}):
  | { readonly id: string; readonly verb: "added" | "inserted" | "used" }
  | undefined {
  if (
    input.call.name === "add_node" ||
    input.call.name === "insert_node_on_edge"
  ) {
    const id = actionId(input.call);
    return id
      ? {
          id,
          verb: input.call.name === "add_node" ? "added" : "inserted",
        }
      : undefined;
  }
  if (input.call.name === "set_wait") {
    return { id: "Wait", verb: "used" };
  }
  if (input.call.name === "set_condition") {
    return { id: "Condition", verb: "used" };
  }
  if (input.call.name !== "update_node") {
    return undefined;
  }
  const nodeId = input.call.input.nodeId;
  const id =
    typeof nodeId === "string" ? input.actionIdsByNode.get(nodeId) : undefined;
  return id ? { id, verb: "used" } : undefined;
}

/**
 * Requires confirmed workflow and action evidence before graph mutations.
 *
 * Each action and Event is held to having been described before it is used,
 * which is what stops the agent inventing one. It is no longer held to being
 * described before the turn's first write: `revert_draft` lets a turn undo
 * everything it did, so finding partway through that a step is needed is a
 * normal way to work rather than a violation.
 */
export function assessEvidenceUse(
  trajectory: AgentTrajectory,
  document: AgentDocument = { nodes: [], edges: [] }
): DeterministicAssessment {
  const actionIdsByNode = nodeActionIds(document, trajectory.calls);

  for (const call of trajectory.calls) {
    if (!WRITE_TOOL_NAMES.has(call.name)) {
      continue;
    }

    if (
      !succeededBefore(
        trajectory.calls,
        call,
        (candidate) => candidate.name === "read_workflow"
      )
    ) {
      return {
        score: 0,
        rationale: `${call.name} was called before a successful read_workflow result.`,
      };
    }

    if (!workflowReadCompletedBefore(trajectory.calls, call)) {
      return {
        score: 0,
        rationale: `${call.name} was called before read_workflow completed every topology page.`,
      };
    }

    const action = usedAction({ call, actionIdsByNode });
    if (call.name === "add_node" || call.name === "insert_node_on_edge") {
      if (action === undefined) {
        return {
          score: 0,
          rationale: `${call.name} was called without an actionId.`,
        };
      }
    }
    if (action) {
      const actionWasDescribed = (boundary: AgentTrajectoryToolCall): boolean =>
        succeededBefore(
          trajectory.calls,
          boundary,
          (candidate) =>
            candidate.name === "describe_action" &&
            actionId(candidate) === action.id
        );
      if (!actionWasDescribed(call)) {
        return {
          score: 0,
          rationale: `${action.id} was ${action.verb} before a successful describe_action result.`,
        };
      }
    }

    for (const eventName of configuredEventNames(call)) {
      const eventWasDescribed = (boundary: AgentTrajectoryToolCall): boolean =>
        succeededBefore(
          trajectory.calls,
          boundary,
          (candidate) =>
            candidate.name === "describe_event" &&
            candidate.input.eventName === eventName
        );
      if (!eventWasDescribed(call)) {
        return {
          score: 0,
          rationale: `${eventName} was used before a successful describe_event result.`,
        };
      }
    }

    const nodeId = call.input.nodeId;
    for (const token of referenceTokensIn(call)) {
      if (
        typeof nodeId !== "string" ||
        !succeededBefore(
          trajectory.calls,
          call,
          (candidate) =>
            candidate.name === "list_references" &&
            candidate.input.nodeId === nodeId &&
            referenceTokensReturnedBy(candidate).includes(token)
        )
      ) {
        return {
          score: 0,
          rationale: `${token} was used before list_references returned that exact token for ${typeof nodeId === "string" ? nodeId : "the target node"}.`,
        };
      }
    }
  }

  return {
    score: 1,
    rationale: "Successful discovery evidence preceded every graph mutation.",
  };
}
