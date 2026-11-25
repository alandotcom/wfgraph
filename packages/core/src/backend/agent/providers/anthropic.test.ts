import { Effect, Layer } from "effect";
import { describe, expect, it } from "@effect/vitest";
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
  messagesAnswer,
  settingsOf,
  streamOnce,
} from "#src/backend/agent/providers/wire-test-support";

describe("wfAnthropic", () => {
  it("leaves the agent off for a blank key, whatever the model", () => {
    expect(
      settingsOf(wfAnthropic({ apiKey: "", model: "claude-opus-5-5" }))
    ).toEqual({ enabled: false });
    expect(settingsOf(wfAnthropic({ apiKey: undefined, model: "" }))).toEqual({
      enabled: false,
    });
  });

  it("refuses a blank model, which Anthropic has no default for", () => {
    expect(() => wfAnthropic({ apiKey: "k", model: " " })).toThrow(
      "wfAnthropic needs a non-blank model"
    );
  });

  it.effect(
    "sends adaptive thinking, the default effort and the key header",
    () =>
      Effect.gen(function* () {
        const settings = enabled(
          wfAnthropic({ apiKey: " sk-ant-test ", model: " claude-opus-5-5 " })
        );
        expect(settings).toMatchObject({
          provider: "anthropic",
          model: "claude-opus-5-5",
          maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
        });

        const { request, text } = yield* streamOnce(settings, messagesAnswer);

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
        enabled(
          wfAnthropic({
            apiKey: "sk-ant-test",
            model: "claude-opus-5-5",
            reasoningEffort: "low",
            baseUrl: "https://gateway.example.test",
          })
        ),
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

      const { request } = yield* streamOnce(
        enabled(
          wfAnthropic({
            apiKey: "sk-ant-test",
            model: "claude-sonnet-5-5",
            reasoningEffort: "medium",
          })
        ),
        messagesAnswer,
        toolkit
      );

      const tools = request.body.tools as { strict?: boolean }[];
      expect(tools.length).toBe(Object.keys(agentToolkit.tools).length);
      expect(tools.length).toBeGreaterThan(20);
      expect(tools.filter((tool) => tool.strict === true)).toEqual([]);
    })
  );
});
