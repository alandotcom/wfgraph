import { Cause, Effect, Stream } from "effect";
import { createHarness, toJsonValue } from "vitest-evals";
import { runAgentTurn } from "@wfgraph/core/backend/agent/chat";
import { DEFAULT_AGENT_MODEL } from "@wfgraph/core/backend/agent/config";
import { getErrorMessage } from "@wfgraph/shared/utils";
import type { AgentStreamPart } from "@wfgraph/shared/rpc/agent-stream";
import {
  assessGraphGrounding,
  assessPublishability,
} from "#src/agent/judges/graph";
import { assessScenarioSemantics } from "#src/agent/judges/semantics";
import { assessToolBehavior } from "#src/agent/judges/tool-behavior";
import { collectAgentEvalResult } from "#src/agent/result";
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
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export const workflowAgentHarness = createHarness<
  AgentEvalInput,
  AgentEvalOutput
>({
  name: "workflow-build-agent",
  run: async ({ input, setArtifact }) => {
    const settings = readEvalModelSettings(input.model);
    const stream = await Effect.runPromise(
      runAgentTurn({
        settings,
        catalog: input.catalog,
        integrations: input.integrations,
        document: input.document,
        messages: input.messages,
      })
    );
    const observed = stream.pipe(
      Stream.catchCause((cause) =>
        Stream.succeed<AgentStreamPart>({
          type: "error",
          message: getErrorMessage(Cause.squash(cause)),
        })
      )
    );
    const parts = Array.from(
      await Effect.runPromise(Stream.runCollect(observed))
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
    const graphInput = {
      document: result.finalDocument,
      catalog: input.catalog,
      integrations: input.integrations,
    };
    const output: AgentEvalOutput = {
      finalDocumentJson: JSON.stringify(result.finalDocument),
      finalText: result.finalText,
      errors: result.errors,
      publishability: assessPublishability(graphInput),
      grounding: assessGraphGrounding(graphInput),
      semantics: assessScenarioSemantics(input, result.finalDocument),
      toolBehavior: assessToolBehavior(events),
    };

    setArtifact(
      "finalDocument",
      toJsonValue(result.finalDocument) ?? { nodes: [], edges: [] }
    );
    setArtifact("streamParts", toJsonValue(parts) ?? []);

    return {
      output,
      events,
      usage: { provider: "openai", model: settings.model },
      errors: result.errors.map((message) => ({ message })),
    };
  },
});
