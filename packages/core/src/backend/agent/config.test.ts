import { Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
  readAgentSettings,
  type WfGraphAgentConfig,
} from "#src/backend/agent/config";
import { wfOpenAi } from "#src/backend/agent/providers/openai";
import { INVALID_TURN_LIMITS } from "#src/backend/agent/providers/wire-test-support";

describe("readAgentSettings", () => {
  it("turns the agent off when the host passes nothing", () => {
    expect(readAgentSettings(undefined)).toEqual({ enabled: false });
  });

  it("reads what a provider function returned", () => {
    expect(readAgentSettings(wfOpenAi({ apiKey: "sk-test" }))).toMatchObject({
      enabled: true,
      provider: "openai",
      maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
    });
    expect(readAgentSettings(wfOpenAi({ apiKey: "" }))).toEqual({
      enabled: false,
    });
  });

  it("carries a host's runner and turns the agent on for it", () => {
    const runner = {
      provider: "host",
      model: "host-model",
      run: () => Stream.empty,
    };

    expect(readAgentSettings({ runner })).toEqual({
      enabled: true,
      runner,
      maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
    });
  });

  it("takes a runner's turn limit and refuses one that is not a count", () => {
    const runner = { provider: "host", model: "m", run: () => Stream.empty };

    expect(readAgentSettings({ runner, maxConcurrentTurns: 16 })).toMatchObject(
      { enabled: true, maxConcurrentTurns: 16 }
    );
    for (const maxConcurrentTurns of INVALID_TURN_LIMITS) {
      expect(() => readAgentSettings({ runner, maxConcurrentTurns })).toThrow(
        "agent.maxConcurrentTurns must be a positive integer"
      );
    }
  });

  // A JavaScript host can pass any value. Each one here is neither what a
  // provider function returns nor `{ runner }`, including a hand-built copy of
  // the settings a provider function carries.
  it.each([
    ["null", null],
    ["false", false],
    ["an empty string", ""],
    ["a plain object naming a key", { apiKey: "sk-test" }],
    ["an object with enabled: true and no modelLayer", { enabled: true }],
    [
      "a hand-built copy of a provider function's settings",
      {
        enabled: true,
        provider: "openai",
        model: "gpt-6.1-terra",
        maxConcurrentTurns: 0,
        modelLayer: () => Layer.empty,
      },
    ],
  ])("refuses %s, saying how to turn the agent off", (_label, agent) => {
    expect(() =>
      readAgentSettings(agent as unknown as WfGraphAgentConfig)
    ).toThrow(
      "agent takes what a provider function returns, such as wfOpenAi from @wfgraph/core/openai, or { runner }. Leave agent out to turn the build agent off."
    );
  });
});
