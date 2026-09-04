import type { Response, Toolkit } from "effect/unstable/ai";
import type { AgentDocument } from "@wfgraph/agent/document";
import type { agentToolkit } from "@wfgraph/agent/toolkit";
import {
  type JsonObject,
  type JsonValue,
  readJsonObject,
  readJsonValue,
} from "@wfgraph/shared/types/json";
import { getErrorMessage } from "@wfgraph/shared/utils";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

type AgentResponsePart = Response.StreamPart<
  Toolkit.Tools<typeof agentToolkit>
>;

export type AgentTraceUsage = {
  readonly inputTokens: {
    readonly uncached?: number | undefined;
    readonly total?: number | undefined;
    readonly cacheRead?: number | undefined;
    readonly cacheWrite?: number | undefined;
  };
  readonly outputTokens: {
    readonly total?: number | undefined;
    readonly text?: number | undefined;
    readonly reasoning?: number | undefined;
  };
};

export type AgentTraceEvent =
  | { readonly type: "model-step-start"; readonly step: number }
  | {
      readonly type: "tool-call";
      readonly step: number;
      readonly id: string;
      readonly name: string;
      readonly input: JsonObject;
    }
  | {
      readonly type: "tool-result";
      readonly step: number;
      readonly id: string;
      readonly name: string;
      readonly result: JsonValue;
      readonly failed: boolean;
      readonly graphRevision?: number | undefined;
    }
  | {
      readonly type: "model-step-finish";
      readonly step: number;
      readonly reason: Response.FinishReason;
      readonly usage: AgentTraceUsage;
    }
  | {
      readonly type: "provider-error";
      readonly step: number;
      readonly error: string;
    }
  | {
      readonly type: "graph-revision";
      readonly step: number;
      readonly toolCallId: string;
      readonly revision: number;
      readonly document: AgentDocument;
    };

export type AgentTraceObserver = (event: AgentTraceEvent) => void;

export type AgentTraceSummary = {
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly refusals: number;
  readonly graphRevisions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly finishReason: Response.FinishReason | undefined;
  readonly finishReasons: Response.FinishReason[];
};

export type AgentTraceAccumulator = {
  readonly observe: AgentTraceObserver;
  readonly summary: () => AgentTraceSummary;
};

/** Maps the response parts needed for trajectory grading onto the private trace. */
export function traceResponsePart(input: {
  readonly step: number;
  readonly part: AgentResponsePart;
  readonly graphRevision?: number | undefined;
}): AgentTraceEvent | undefined {
  switch (input.part.type) {
    case "tool-call":
      return {
        type: "tool-call",
        step: input.step,
        id: input.part.id,
        name: input.part.name,
        input: readJsonObject(input.part.params) ?? {},
      };
    case "tool-result":
      return omitUndefined({
        type: "tool-result" as const,
        step: input.step,
        id: input.part.id,
        name: input.part.name,
        result: readJsonValue(input.part.encodedResult),
        failed: input.part.isFailure,
        graphRevision: input.graphRevision,
      });
    case "finish":
      return {
        type: "model-step-finish",
        step: input.step,
        reason: input.part.reason,
        usage: {
          inputTokens: { ...input.part.usage.inputTokens },
          outputTokens: { ...input.part.usage.outputTokens },
        },
      };
    case "error":
      return {
        type: "provider-error",
        step: input.step,
        error: getErrorMessage(input.part.error),
      };
    default:
      return undefined;
  }
}

/** Returns a failure for provider finishes that leave the turn incomplete. */
export function finishReasonFailure(
  reason: Response.FinishReason
): Error | undefined {
  switch (reason) {
    case "stop":
    case "tool-calls":
      return undefined;
    case "length":
      return new Error("The model stopped because it reached its token limit.");
    case "content-filter":
      return new Error(
        "The model stopped because a content filter blocked its response."
      );
    case "error":
      return new Error("The model provider stopped with an error.");
    case "pause":
      return new Error("The model paused before it completed the turn.");
    case "other":
    case "unknown":
      return new Error(
        "The model stopped before it completed the turn for an unknown reason."
      );
    default:
      return unexpectedFinishReason(reason);
  }
}

function unexpectedFinishReason(reason: never): never {
  throw new Error(`Unexpected model finish reason: ${String(reason)}`);
}

/** Reduces a payload-bearing trace to the aggregate fields safe for logs. */
export function summarizeAgentTrace(
  events: readonly AgentTraceEvent[]
): AgentTraceSummary {
  const accumulator = makeAgentTraceAccumulator();
  for (const event of events) {
    accumulator.observe(event);
  }
  return accumulator.summary();
}

/** Collects aggregate counts while discarding tool and workflow payloads. */
export function makeAgentTraceAccumulator(): AgentTraceAccumulator {
  let modelCalls = 0;
  let toolCalls = 0;
  let refusals = 0;
  let graphRevisions = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  const finishReasons: Response.FinishReason[] = [];

  const observe = (event: AgentTraceEvent) => {
    switch (event.type) {
      case "model-step-start":
        modelCalls += 1;
        break;
      case "tool-call":
        toolCalls += 1;
        break;
      case "tool-result":
        if (event.failed) {
          refusals += 1;
        }
        break;
      case "graph-revision":
        graphRevisions += 1;
        break;
      case "model-step-finish":
        finishReasons.push(event.reason);
        inputTokens += event.usage.inputTokens.total ?? 0;
        outputTokens += event.usage.outputTokens.total ?? 0;
        reasoningTokens += event.usage.outputTokens.reasoning ?? 0;
        break;
      case "provider-error":
        break;
    }
  };

  return {
    observe,
    summary: () => ({
      modelCalls,
      toolCalls,
      refusals,
      graphRevisions,
      inputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens: inputTokens + outputTokens,
      finishReason: finishReasons.at(-1),
      finishReasons: [...finishReasons],
    }),
  };
}
