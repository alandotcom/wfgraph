import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { LanguageModel } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import {
  layerFromDraft,
  type WorkflowDraftService,
} from "@wfgraph/agent/document";
import { agentToolkit, agentToolkitLayer } from "@wfgraph/agent/toolkit";
import { DEFAULT_MAX_CONCURRENT_AGENT_TURNS } from "#src/backend/agent/config";
import { MAX_AGENT_OUTPUT_TOKENS } from "#src/backend/agent/model";
import { wfAnthropic } from "#src/backend/agent/providers/anthropic";
import {
  enabled,
  INVALID_TURN_LIMITS,
  recordingFetch,
  sse,
  streamOnce,
} from "#src/backend/agent/providers/wire-test-support";

/** A Messages API stream answering "Ready", in the shape Anthropic documents. */
function messagesAnswer(): Response {
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Ready" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

describe("wfAnthropic", () => {
  it("leaves the agent off for a blank key, whatever the model", () => {
    expect(wfAnthropic({ apiKey: "", model: "claude-opus-5-5" })).toEqual({
      enabled: false,
    });
    expect(wfAnthropic({ apiKey: undefined, model: "" })).toEqual({
      enabled: false,
    });
  });

  it("refuses a blank model, which Anthropic has no default for", () => {
    expect(() => wfAnthropic({ apiKey: "k", model: " " })).toThrow(
      'agent.model is required for the "anthropic" provider'
    );
  });

  it.effect(
    "sends adaptive thinking, the default effort and the key header",
    () =>
      Effect.gen(function* () {
        const agent = wfAnthropic({
          apiKey: " sk-ant-test ",
          model: " claude-opus-5-5 ",
        });
        expect(agent).toMatchObject({
          enabled: true,
          provider: "anthropic",
          model: "claude-opus-5-5",
          maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
        });

        const { request, text } = yield* streamOnce(agent, messagesAnswer);

        expect(request.url).toBe("https://api.anthropic.com/v1/messages");
        expect(request.headers.get("x-api-key")).toBe("sk-ant-test");
        expect(request.body).toMatchObject({
          model: "claude-opus-5-5",
          max_tokens: MAX_AGENT_OUTPUT_TOKENS,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: "high" },
          cache_control: { type: "ephemeral" },
        });
        expect(text).toBe("Ready");
      })
  );

  it.effect("takes the host's effort and endpoint", () =>
    Effect.gen(function* () {
      const { request } = yield* streamOnce(
        wfAnthropic({
          apiKey: "sk-ant-test",
          model: "claude-opus-5-5",
          reasoningEffort: "low",
          baseUrl: "https://gateway.example.test",
        }),
        messagesAnswer
      );

      expect(request.url).toBe("https://gateway.example.test/v1/messages");
      expect(request.body).toMatchObject({ output_config: { effort: "low" } });
    })
  );

  // Anthropic refuses a request that marks more than 20 tools strict, and
  // Effect's client marks every tool strict unless told otherwise. The toolkit
  // holds more tools than that.
  it.effect("sends the whole toolkit with no tool marked strict", () =>
    Effect.gen(function* () {
      const { fetch, requests } = recordingFetch(() =>
        sse([
          {
            type: "message_start",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-5-5",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ])
      );
      const unused = () => Effect.die("unused");
      const empty = { nodes: [], edges: [] };
      const draft: WorkflowDraftService = {
        current: Effect.succeed(empty),
        update: unused,
        transaction: unused,
        revision: () => Effect.succeed(empty),
        latest: Effect.succeed({ revision: 1, document: empty }),
        catalog: { actions: [], entities: [], events: [], integrations: [] },
        integrations: [],
        validateDraft: () => ({
          draftValid: true,
          structuralIssues: [],
          publishBlockers: [],
          warnings: [],
        }),
      };
      const toolkit = yield* Effect.provide(
        agentToolkit,
        agentToolkitLayer.pipe(Layer.provide(layerFromDraft(draft)))
      );
      const agent = enabled(
        wfAnthropic({
          apiKey: "sk-ant-test",
          model: "claude-sonnet-5-5",
          reasoningEffort: "medium",
        })
      );

      yield* LanguageModel.LanguageModel.pipe(
        Effect.flatMap((model) =>
          Stream.runCollect(model.streamText({ prompt: "Hello", toolkit }))
        ),
        Effect.provide(agent.modelLayer({ workflowId: "workflow-1" })),
        Effect.provideService(FetchHttpClient.Fetch, fetch)
      );

      const tools = requests[0]?.body.tools as { strict?: boolean }[];
      expect(tools.length).toBe(Object.keys(agentToolkit.tools).length);
      expect(tools.length).toBeGreaterThan(20);
      expect(tools.filter((tool) => tool.strict === true)).toEqual([]);
    })
  );

  it("takes the host's turn limit and refuses one that is not a count", () => {
    const options = { apiKey: "sk-ant-test", model: "claude-opus-5-5" };
    expect(wfAnthropic({ ...options, maxConcurrentTurns: 16 })).toMatchObject({
      maxConcurrentTurns: 16,
    });
    for (const maxConcurrentTurns of INVALID_TURN_LIMITS) {
      expect(() => wfAnthropic({ ...options, maxConcurrentTurns })).toThrow(
        "agent.maxConcurrentTurns must be a positive integer"
      );
    }
  });
});
