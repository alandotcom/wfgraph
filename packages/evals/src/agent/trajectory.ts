import type { AgentDocument } from "@wfgraph/agent/document";
import type {
  AgentTraceEvent,
  AgentTraceUsage,
} from "@wfgraph/core/backend/agent/trace";
import { WRITE_TOOL_NAMES } from "@wfgraph/agent/toolkit";
import { type JsonObject, type JsonValue } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  normalizeAgentEvalDocument,
  normalizeJsonObjectEvidence,
  type JsonNormalized,
} from "#src/agent/evidence";
import type { AgentEvalDocument } from "#src/agent/result";

export type AgentTrajectoryToolResult = {
  order: number;
  step: number;
  id: string;
  name: string;
  result: JsonValue;
  failed: boolean;
  graphRevision?: number | undefined;
};

export type AgentTrajectoryDocument = JsonNormalized<AgentEvalDocument>;

type AgentTrajectoryGraphRevisionBase = {
  order: number;
  step: number;
  toolCallId: string;
  revision: number;
  document: AgentTrajectoryDocument;
};

export type AgentTrajectoryMatchedGraphRevision =
  AgentTrajectoryGraphRevisionBase & {
    matchStatus: "matched";
    toolCallOrder: number;
    toolResultOrder: number;
  };

export type AgentTrajectoryUnmatchedGraphRevision =
  AgentTrajectoryGraphRevisionBase & {
    matchStatus: "unmatched";
  };

export type AgentTrajectoryGraphRevision =
  | AgentTrajectoryMatchedGraphRevision
  | AgentTrajectoryUnmatchedGraphRevision;

/** Records how one successful write result pairs with revision events. */
export type AgentTrajectoryGraphRevisionWrite = {
  step: number;
  toolCallId: string;
  toolCallOrder: number;
  toolResultOrder: number;
  revision?: number | undefined;
  matchStatus: "matched" | "missing" | "duplicate";
  graphRevisionOrders: number[];
};

export type AgentTrajectoryGraphRevisionSequenceIssue =
  | "missing-write-revision"
  | "duplicate-write-revision"
  | "events-out-of-write-order"
  | "revisions-not-sequential";

/** Records whether successful writes produced the global revision sequence. */
export type AgentTrajectoryGraphRevisionSequence = {
  status: "valid" | "invalid";
  issues: AgentTrajectoryGraphRevisionSequenceIssue[];
};

export type AgentTrajectoryToolCall = {
  order: number;
  step: number;
  id: string;
  name: string;
  input: JsonObject;
  result?: AgentTrajectoryToolResult | undefined;
};

export type AgentTrajectoryModelFinish = {
  order: number;
  step: number;
  reason: Extract<
    AgentTraceEvent,
    { readonly type: "model-step-finish" }
  >["reason"];
  usage: JsonObject;
};

export type AgentTrajectoryProviderError = {
  order: number;
  step: number;
  error: string;
};

/**
 * The complete JSON-safe sequence used by deterministic trajectory judges.
 * Calls keep their model order while result and revision order preserve the
 * event position needed to distinguish a fresh validation from a stale one.
 */
export type AgentTrajectory = {
  calls: AgentTrajectoryToolCall[];
  unmatchedResults: AgentTrajectoryToolResult[];
  graphRevisions: AgentTrajectoryGraphRevision[];
  graphRevisionWrites: AgentTrajectoryGraphRevisionWrite[];
  graphRevisionSequence: AgentTrajectoryGraphRevisionSequence;
  modelFinishes: AgentTrajectoryModelFinish[];
  providerErrors: AgentTrajectoryProviderError[];
};

/** Returns calls that did not receive a matching result in the trace. */
export function selectUnresolvedCalls(
  trajectory: AgentTrajectory
): AgentTrajectoryToolCall[] {
  return trajectory.calls.filter((call) => call.result === undefined);
}

/** Returns revisions with exactly one matching successful graph-writing result. */
export function selectSuccessfulGraphRevisions(
  trajectory: AgentTrajectory
): AgentTrajectoryMatchedGraphRevision[] {
  const consistentRevisionOrders = new Set(
    trajectory.graphRevisionWrites.flatMap((write) =>
      write.matchStatus === "matched" ? write.graphRevisionOrders : []
    )
  );
  return trajectory.graphRevisions.filter(
    (revision): revision is AgentTrajectoryMatchedGraphRevision =>
      revision.matchStatus === "matched" &&
      consistentRevisionOrders.has(revision.order)
  );
}

/** Returns every successful graph write and its revision consistency. */
export function selectGraphRevisionWrites(
  trajectory: AgentTrajectory
): AgentTrajectoryGraphRevisionWrite[] {
  return trajectory.graphRevisionWrites;
}

/** Returns successful graph writes that lack one exact graph-revision event. */
export function selectInconsistentGraphRevisionWrites(
  trajectory: AgentTrajectory
): AgentTrajectoryGraphRevisionWrite[] {
  return trajectory.graphRevisionWrites.filter(
    (write) => write.matchStatus !== "matched"
  );
}

/** Returns revisions that did not link to a successful graph-writing result. */
export function selectUnmatchedGraphRevisions(
  trajectory: AgentTrajectory
): AgentTrajectoryUnmatchedGraphRevision[] {
  return trajectory.graphRevisions.filter(
    (revision): revision is AgentTrajectoryUnmatchedGraphRevision =>
      revision.matchStatus === "unmatched"
  );
}

function normalizedDocument(document: AgentDocument): AgentTrajectoryDocument {
  return normalizeAgentEvalDocument(document);
}

function normalizedUsage(value: AgentTraceUsage): JsonObject {
  return normalizeJsonObjectEvidence(value, "Agent trace model usage");
}

function graphRevisionWriteMatchStatus(
  graphRevisionOrders: readonly number[]
): AgentTrajectoryGraphRevisionWrite["matchStatus"] {
  switch (graphRevisionOrders.length) {
    case 0:
      return "missing";
    case 1:
      return "matched";
    default:
      return "duplicate";
  }
}

function graphRevisionEventsFollowWriteOrder(
  writes: readonly AgentTrajectoryGraphRevisionWrite[]
): boolean {
  return writes.every((write, index) => {
    if (index === 0) {
      return true;
    }

    const earlierWrite = writes[index - 1];
    const earlierGraphRevisionOrder = earlierWrite?.graphRevisionOrders[0];
    const graphRevisionOrder = write.graphRevisionOrders[0];
    return (
      earlierGraphRevisionOrder !== undefined &&
      graphRevisionOrder !== undefined &&
      earlierGraphRevisionOrder < graphRevisionOrder
    );
  });
}

function graphRevisionSequence(
  writes: readonly AgentTrajectoryGraphRevisionWrite[]
): AgentTrajectoryGraphRevisionSequence {
  const correspondenceIssues = writes.flatMap(
    (write): AgentTrajectoryGraphRevisionSequenceIssue[] =>
      write.matchStatus === "missing"
        ? ["missing-write-revision"]
        : write.matchStatus === "duplicate"
          ? ["duplicate-write-revision"]
          : []
  );
  const matchedWrites = writes
    .filter((write) => write.matchStatus === "matched")
    .toSorted(
      (firstWrite, secondWrite) =>
        firstWrite.toolResultOrder - secondWrite.toolResultOrder
    );
  const allWritesMatched = matchedWrites.length === writes.length;
  const issues: AgentTrajectoryGraphRevisionSequenceIssue[] = [
    ...correspondenceIssues,
    ...(allWritesMatched && !graphRevisionEventsFollowWriteOrder(matchedWrites)
      ? ["events-out-of-write-order" as const]
      : []),
    ...(allWritesMatched &&
    !matchedWrites.every((write, index) => write.revision === index + 1)
      ? ["revisions-not-sequential" as const]
      : []),
  ];

  return {
    status: issues.length === 0 ? "valid" : "invalid",
    issues,
  };
}

function toolResult(
  event: Extract<AgentTraceEvent, { readonly type: "tool-result" }>,
  order: number
): AgentTrajectoryToolResult {
  return omitUndefined({
    order,
    step: event.step,
    id: event.id,
    name: event.name,
    result: event.result,
    failed: event.failed,
    graphRevision: event.graphRevision,
  });
}

/** Pairs raw trace events into one serializable view for all trajectory gates. */
export function buildAgentTrajectory(
  events: readonly AgentTraceEvent[]
): AgentTrajectory {
  const calls = events.flatMap((event, order) =>
    event.type === "tool-call"
      ? [
          {
            order,
            step: event.step,
            id: event.id,
            name: event.name,
            input: event.input,
          },
        ]
      : []
  );
  const resultByCallOrder = new Map<number, AgentTrajectoryToolResult>();
  const unmatchedResults: AgentTrajectoryToolResult[] = [];
  const graphRevisions: AgentTrajectoryGraphRevision[] = [];
  const graphRevisionOrdersByCallOrder = new Map<number, number[]>();
  const modelFinishes: AgentTrajectoryModelFinish[] = [];
  const providerErrors: AgentTrajectoryProviderError[] = [];

  for (const [order, event] of events.entries()) {
    switch (event.type) {
      case "tool-result": {
        const result = toolResult(event, order);
        const call = calls.find(
          (candidate) =>
            candidate.order < order &&
            candidate.step === event.step &&
            candidate.id === event.id &&
            candidate.name === event.name &&
            !resultByCallOrder.has(candidate.order)
        );
        if (call === undefined) {
          unmatchedResults.push(result);
        } else {
          resultByCallOrder.set(call.order, result);
        }
        break;
      }
      case "graph-revision":
        {
          const linkedCall = calls.findLast((candidate) => {
            const result = resultByCallOrder.get(candidate.order);
            return (
              candidate.order < order &&
              candidate.step === event.step &&
              candidate.id === event.toolCallId &&
              WRITE_TOOL_NAMES.has(candidate.name) &&
              result !== undefined &&
              result.order < order &&
              !result.failed &&
              result.graphRevision === event.revision
            );
          });
          const linkedResult =
            linkedCall === undefined
              ? undefined
              : resultByCallOrder.get(linkedCall.order);
          const graphRevision: AgentTrajectoryGraphRevision =
            linkedCall === undefined || linkedResult === undefined
              ? {
                  order,
                  step: event.step,
                  toolCallId: event.toolCallId,
                  matchStatus: "unmatched",
                  revision: event.revision,
                  document: normalizedDocument(event.document),
                }
              : {
                  order,
                  step: event.step,
                  toolCallId: event.toolCallId,
                  matchStatus: "matched",
                  toolCallOrder: linkedCall.order,
                  toolResultOrder: linkedResult.order,
                  revision: event.revision,
                  document: normalizedDocument(event.document),
                };
          graphRevisions.push(graphRevision);
          if (linkedCall !== undefined && linkedResult !== undefined) {
            const graphRevisionOrders =
              graphRevisionOrdersByCallOrder.get(linkedCall.order) ?? [];
            graphRevisionOrders.push(order);
            graphRevisionOrdersByCallOrder.set(
              linkedCall.order,
              graphRevisionOrders
            );
          }
        }
        break;
      case "model-step-finish":
        modelFinishes.push({
          order,
          step: event.step,
          reason: event.reason,
          usage: normalizedUsage(event.usage),
        });
        break;
      case "provider-error":
        providerErrors.push({ order, step: event.step, error: event.error });
        break;
      case "model-step-start":
      case "tool-call":
        break;
    }
  }

  const pairedCalls = calls.map((call) => {
    const result = resultByCallOrder.get(call.order);
    return omitUndefined({
      ...call,
      result,
    });
  });
  const graphRevisionWrites = calls.flatMap((call) => {
    const result = resultByCallOrder.get(call.order);
    if (
      !WRITE_TOOL_NAMES.has(call.name) ||
      result === undefined ||
      result.failed
    ) {
      return [];
    }

    const graphRevisionOrders =
      graphRevisionOrdersByCallOrder.get(call.order) ?? [];
    return [
      omitUndefined({
        step: call.step,
        toolCallId: call.id,
        toolCallOrder: call.order,
        toolResultOrder: result.order,
        revision: result.graphRevision,
        matchStatus: graphRevisionWriteMatchStatus(graphRevisionOrders),
        graphRevisionOrders,
      }),
    ];
  });

  return {
    calls: pairedCalls,
    unmatchedResults,
    graphRevisions,
    graphRevisionWrites,
    graphRevisionSequence: graphRevisionSequence(graphRevisionWrites),
    modelFinishes,
    providerErrors,
  };
}
