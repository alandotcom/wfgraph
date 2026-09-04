import { Cause, Effect, Stream } from "effect";
import { createHarness } from "vitest-evals";
import {
  type AgentReasoningEffort,
  type EnabledAgentSettings,
  AGENT_REASONING_EFFORTS,
  DEFAULT_AGENT_REASONING_EFFORT,
  readAgentSettings,
} from "@wfgraph/core/backend/agent/config";
import { validateAgentDraft } from "@wfgraph/core/backend/agent/publication-validation";
import {
  runAgentRunner,
  type AgentRunner,
} from "@wfgraph/core/backend/agent/runner";
import { makeAgentToolSession } from "@wfgraph/core/backend/agent/tool-session";
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
const REASONING_EFFORT_ENV = "WFGRAPH_EVAL_REASONING_EFFORT";

/**
 * The effort this run measures, refusing an unknown one.
 *
 * A typo would otherwise be silently dropped and the run would report the
 * default's numbers under the name of whatever was asked for.
 */
function readReasoningEffort(): AgentReasoningEffort {
  const requested = process.env[REASONING_EFFORT_ENV]?.trim();
  if (!requested) {
    return DEFAULT_AGENT_REASONING_EFFORT;
  }

  const effort = AGENT_REASONING_EFFORTS.find((known) => known === requested);
  if (!effort) {
    throw new Error(
      `${REASONING_EFFORT_ENV} is "${requested}". Use one of ${AGENT_REASONING_EFFORTS.join(", ")}.`
    );
  }
  return effort;
}

/**
 * The settings a run measures against, resolved the way a host's would be.
 *
 * `readAgentSettings` owns every default and the rule for a blank value, so a
 * change to how the application resolves its model cannot leave the evals
 * measuring the old one. What is added here is where the values come from, the
 * environment rather than an option, and that a missing key is fatal to a run
 * whose whole purpose is to call a model.
 */
export function readEvalModelSettings(
  modelOverride?: string
): EnabledAgentSettings {
  const settings = readAgentSettings({
    apiKey: process.env[API_KEY_ENV],
    model: modelOverride?.trim() || process.env[AGENT_MODEL_ENV],
    reasoningEffort: readReasoningEffort(),
    baseUrl: process.env.OPENAI_BASE_URL,
  });

  if (!settings.enabled) {
    throw new Error(
      `Set ${API_KEY_ENV} before running the model-backed agent evals.`
    );
  }
  return settings;
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

export type AgentEvalRunner = (input: AgentEvalInput) => AgentRunner;

/** Builds the eval harness around the runner under assessment. */
export function createWorkflowAgentHarness(resolveRunner: AgentEvalRunner) {
  return createHarness<AgentEvalInput, AgentEvalOutput>({
    name: "workflow-build-agent",
    run: async ({ input, setArtifact, signal }) => {
      const startedAt = Date.now();
      const runner = resolveRunner(input);
      const trace: AgentTraceEvent[] = [];
      const session = await Effect.runPromise(
        makeAgentToolSession({
          catalog: input.catalog,
          integrations: input.integrations,
          document: input.document,
          validateDraft: (document) =>
            validateAgentDraft({
              document,
              catalog: input.catalog,
              integrations: input.integrations,
            }),
        }),
        { signal }
      );
      const parts = await collectAgentTurn(
        Effect.succeed(
          runAgentRunner(runner, {
            messages: input.messages,
            session,
            observeTrace: (event) => trace.push(event),
          })
        ),
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
      setArtifact(
        "agentTrace",
        normalizeJsonEvidence(trace, "Agent eval trace")
      );

      return {
        output,
        events,
        usage: {
          provider: runner.metadata.provider,
          model: runner.metadata.model,
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
}
