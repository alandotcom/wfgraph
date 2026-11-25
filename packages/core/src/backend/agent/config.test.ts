import { Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
  readAgentSettings,
  type WfGraphAgentConfig,
} from "#src/backend/agent/config";
import { wfOpenAi } from "#src/backend/agent/providers/openai";

describe("readAgentSettings", () => {
  it("turns the agent off when the host passes nothing", () => {
    expect(readAgentSettings(undefined)).toEqual({ enabled: false });
  });

  it("carries what a provider function returned as it is", () => {
    const agent = wfOpenAi({ apiKey: "sk-test" });

    expect(readAgentSettings(agent)).toBe(agent);
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
    for (const maxConcurrentTurns of [0, -1, 1.5, Number.NaN]) {
      expect(() => readAgentSettings({ runner, maxConcurrentTurns })).toThrow(
        "agent.maxConcurrentTurns must be a positive integer"
      );
    }
  });

  it("refuses a plain object naming a key, from a JavaScript host", () => {
    const plain = { apiKey: "sk-test" } as unknown as WfGraphAgentConfig;

    expect(() => readAgentSettings(plain)).toThrow(
      "agent takes what a provider function returns"
    );
  });
});
