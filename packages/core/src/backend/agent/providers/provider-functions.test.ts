import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
  type WfGraphAgentModel,
} from "#src/backend/agent/config";
import { wfAnthropic } from "#src/backend/agent/providers/anthropic";
import { wfOpenAi } from "#src/backend/agent/providers/openai";
import { wfOpenAiCompatible } from "#src/backend/agent/providers/openai-compatible";
import { wfOpenRouter } from "#src/backend/agent/providers/openrouter";
import {
  enabled,
  INVALID_TURN_LIMITS,
  settingsOf,
} from "#src/backend/agent/providers/wire-test-support";

/**
 * Each provider function, called with the option that turns the agent on (the
 * key, or the base URL for `wfOpenAiCompatible`) either set or blank.
 */
const PROVIDER_FUNCTIONS: readonly {
  readonly name: string;
  readonly build: (
    switchSet: boolean,
    maxConcurrentTurns?: number
  ) => WfGraphAgentModel;
}[] = [
  {
    name: "wfOpenAi",
    build: (switchSet, maxConcurrentTurns) =>
      wfOpenAi({ apiKey: switchSet ? "sk-test" : "", maxConcurrentTurns }),
  },
  {
    name: "wfAnthropic",
    build: (switchSet, maxConcurrentTurns) =>
      wfAnthropic({
        apiKey: switchSet ? "sk-ant-test" : "",
        model: "claude-opus-5-5",
        maxConcurrentTurns,
      }),
  },
  {
    name: "wfOpenRouter",
    build: (switchSet, maxConcurrentTurns) =>
      wfOpenRouter({
        apiKey: switchSet ? "sk-or-test" : "",
        model: "openai/gpt-6.1-terra",
        maxConcurrentTurns,
      }),
  },
  {
    name: "wfOpenAiCompatible",
    build: (switchSet, maxConcurrentTurns) =>
      wfOpenAiCompatible({
        baseUrl: switchSet ? "http://localhost:11434/v1" : "",
        model: "qwen3",
        maxConcurrentTurns,
      }),
  },
];

describe.each(PROVIDER_FUNCTIONS)("$name", ({ name, build }) => {
  it("leaves the agent off when the option that turns it on is blank", () => {
    expect(settingsOf(build(false))).toEqual({ enabled: false });
  });

  it("keeps a valid turn limit and defaults an absent one", () => {
    expect(enabled(build(true, 16)).maxConcurrentTurns).toBe(16);
    expect(enabled(build(true)).maxConcurrentTurns).toBe(
      DEFAULT_MAX_CONCURRENT_AGENT_TURNS
    );
  });

  it.each(INVALID_TURN_LIMITS)(
    "refuses a turn limit of %s, whether the agent would be on or off",
    (maxConcurrentTurns) => {
      const message = `${name}'s maxConcurrentTurns must be a positive integer`;
      expect(() => build(true, maxConcurrentTurns)).toThrow(message);
      expect(() => build(false, maxConcurrentTurns)).toThrow(message);
    }
  );
});
