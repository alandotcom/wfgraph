import { Cause, Effect, Stream } from "effect";
import { createHarness } from "vitest-evals";
import { runAgentTurn } from "@wfgraph/core/backend/agent/chat";
import { DEFAULT_AGENT_MODEL } from "@wfgraph/core/backend/agent/config";
import { validateAgentDraft } from "@wfgraph/core/backend/agent/publication-validation";
import {
  summarizeAgentTrace,
  type AgentTraceEvent,
} from "@wfgraph/core/backend/agent/trace";
import { getErrorMessage } from "@wfgraph/shared/utils";
import type { AgentStreamPart } from "@wfgraph/shared/rpc/agent-stream";
import { collectCompletionFacts } from "#src/agent/completion-facts";
import {
  normalizeAgentEvalDocument,
  normalizeJsonEvidence,
  normalizeJsonObjectEvidence,
} from "#src/agent/evidence";
import { collectAgentEvalResult } from "#src/agent/result";
import { buildAgentTrajectory } from "#src/agent/trajectory";
import type { AgentEvalInput, AgentEvalOutput } from "#src/agent/types";

const API_KEY_ENV = "OPENAI_API_KEY";
const AGENT_MODEL_ENV = "WFGRAPH_EVAL_AGENT_MODEL";

export function readEvalModelSettings(modelOverride?: string) {
  const apiKey = process.env[API_KEY_ENV]?.trim();
  if (!apiKey) {
    throw new Error(
      `Set ${API_KEY_ENV} before running the model-backed agent evals.`
    );
  }

  const model =
    modelOverride?.trim() ||
    process.env[AGENT_MODEL_ENV]?.trim() ||
    DEFAULT_AGENT_MODEL;
  const baseUrl = process.env.OPENAI_BASE_URL?.trim();

  return {
    enabled: true as const,
    apiKey,
    model,
    // oxlint-disable-next-line wfgraph/no-conditional-spread -- an empty `baseUrl` means none, so the key is left off instead of sent as an empty string.
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/** Builds one turn and collects its stream under the same interruption signal. */
export function collectAgentTurn(
  turn: Effect.Effect<Stream.Stream<AgentStreamPart, unknown>>,
  signal: AbortSignal | undefined
): Promise<AgentStreamPart[]> {
  const collected = Effect.gen(function* () {
    const stream = yield* turn;
    const observed: Stream.Stream<AgentStreamPart> = stream.pipe(
      Stream.catchCause((cause) =>
        Stream.succeed<AgentStreamPart>({
          type: "error",
          message: getErrorMessage(Cause.squash(cause)),
        })
      )
    );
    return Array.from(yield* Stream.runCollect(observed));
  });
  return Effect.runPromise(collected, { signal });
}

export const workflowAgentHarness = createHarness<
  AgentEvalInput,
  AgentEvalOutput
>({
  name: "workflow-build-agent",
  run: async ({ input, setArtifact, signal }) => {
    const startedAt = Date.now();
    const settings = readEvalModelSettings(input.model);
    const trace: AgentTraceEvent[] = [];
    const parts = await collectAgentTurn(
      runAgentTurn({
        settings,
        catalog: input.catalog,
        integrations: input.integrations,
        document: input.document,
        messages: input.messages,
        observeTrace: (event) => trace.push(event),
      }),
      signal
    );
    const result = collectAgentEvalResult(input.document, parts);
    const events = [
      ...input.messages.map((message) => ({
        type: "message" as const,
        role: message.role,
        content: message.content,
      })),
      ...result.events,
    ];
    const traceSummary = summarizeAgentTrace(trace);
    const trajectory = buildAgentTrajectory(trace);
    const finalDocument = normalizeAgentEvalDocument(result.finalDocument);
    const validation = validateAgentDraft({
      document: finalDocument,
      catalog: input.catalog,
      integrations: input.integrations,
    });
    const completionFacts = collectCompletionFacts({
      validation,
      finalText: result.finalText,
      streamErrors: result.errors,
      finalFinishReason: traceSummary.finishReason,
    });
    const normalizedTraceSummary = normalizeJsonObjectEvidence(
      {
        ...traceSummary,
        finishReason: traceSummary.finishReason ?? null,
      },
      "Agent eval trace summary"
    );
    const output: AgentEvalOutput = {
      finalDocument,
      finalText: result.finalText,
      errors: result.errors,
      completionFacts: normalizeJsonObjectEvidence(
        completionFacts,
        "Agent eval completion facts"
      ),
      trajectory: normalizeJsonObjectEvidence(
        trajectory,
        "Agent eval trajectory"
      ),
      traceSummary: normalizedTraceSummary,
    };

    setArtifact("finalDocument", finalDocument);
    setArtifact(
      "streamParts",
      normalizeJsonEvidence(parts, "Agent eval stream parts")
    );
    setArtifact("agentTrace", normalizeJsonEvidence(trace, "Agent eval trace"));

    return {
      output,
      events,
      usage: {
        provider: "openai",
        model: settings.model,
        inputTokens: traceSummary.inputTokens,
        outputTokens: traceSummary.outputTokens,
        reasoningTokens: traceSummary.reasoningTokens,
        totalTokens: traceSummary.totalTokens,
        toolCalls: traceSummary.toolCalls,
        metadata: {
          modelCalls: traceSummary.modelCalls,
          refusals: traceSummary.refusals,
          graphRevisions: traceSummary.graphRevisions,
          finishReason: traceSummary.finishReason ?? "missing",
          finishReasons: traceSummary.finishReasons,
        },
      },
      timings: { totalMs: Date.now() - startedAt },
      errors: result.errors.map((message) => ({ message })),
    };
  },
});
