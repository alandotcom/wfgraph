import { Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
  DEFAULT_AGENT_REASONING_EFFORT,
  readAgentSettings,
} from "#src/backend/agent/config";

describe("readAgentSettings", () => {
  it("turns the agent off when the host passes nothing", () => {
    expect(readAgentSettings(undefined)).toEqual({ enabled: false });
  });

  it("reads a half-filled environment as off rather than as broken", () => {
    // `process.env.OPENAI_API_KEY` on a machine with the line present but empty.
    expect(readAgentSettings({ apiKey: "" })).toEqual({ enabled: false });
    expect(readAgentSettings({ apiKey: "   " })).toEqual({ enabled: false });
    expect(readAgentSettings({ apiKey: undefined })).toEqual({
      enabled: false,
    });
  });

  it("names a default model when the host names none", () => {
    expect(readAgentSettings({ apiKey: "sk-test" })).toEqual({
      enabled: true,
      maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
      provider: "openai",
      apiKey: "sk-test",
      model: DEFAULT_AGENT_MODEL,
      reasoningEffort: DEFAULT_AGENT_REASONING_EFFORT,
    });
  });

  it("takes the host's reasoning effort when it names one", () => {
    expect(
      readAgentSettings({ apiKey: "sk-test", reasoningEffort: "low" })
    ).toEqual({
      enabled: true,
      maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
      provider: "openai",
      apiKey: "sk-test",
      model: DEFAULT_AGENT_MODEL,
      reasoningEffort: "low",
    });
  });

  it("takes the host's model and endpoint when it names them", () => {
    expect(
      readAgentSettings({
        apiKey: "  sk-test  ",
        model: " gpt-4.1 ",
        baseUrl: "https://gateway.example.test/v1",
      })
    ).toEqual({
      enabled: true,
      maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-4.1",
      reasoningEffort: DEFAULT_AGENT_REASONING_EFFORT,
      baseUrl: "https://gateway.example.test/v1",
    });
  });

  it("leaves baseUrl off rather than sending an empty one", () => {
    const settings = readAgentSettings({ apiKey: "sk-test", baseUrl: "" });

    expect(settings).not.toHaveProperty("baseUrl");
  });

  it("reads an Anthropic key, model and effort", () => {
    expect(
      readAgentSettings({
        provider: "anthropic",
        apiKey: " sk-ant ",
        model: " claude-opus-5-5 ",
      })
    ).toEqual({
      enabled: true,
      maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
      provider: "anthropic",
      apiKey: "sk-ant",
      model: "claude-opus-5-5",
      reasoningEffort: "high",
    });
  });

  it("refuses a blank model for a provider with no default", () => {
    expect(() =>
      readAgentSettings({ provider: "anthropic", apiKey: "k", model: " " })
    ).toThrow('agent.model is required for the "anthropic" provider');
    expect(() =>
      readAgentSettings({ provider: "openrouter", apiKey: "k", model: "" })
    ).toThrow('agent.model is required for the "openrouter" provider');
  });

  it("sends OpenRouter no reasoning effort unless the host names one", () => {
    expect(
      readAgentSettings({
        provider: "openrouter",
        apiKey: "sk-or",
        model: "anthropic/claude-opus-5-5",
      })
    ).toEqual({
      enabled: true,
      maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
      provider: "openrouter",
      apiKey: "sk-or",
      model: "anthropic/claude-opus-5-5",
    });
  });

  it("turns an OpenAI-compatible server on by its base URL, with no key", () => {
    expect(
      readAgentSettings({
        provider: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen3",
      })
    ).toEqual({
      enabled: true,
      maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen3",
    });
    expect(
      readAgentSettings({
        provider: "openai-compatible",
        baseUrl: " ",
        apiKey: "key",
        model: "qwen3",
      })
    ).toEqual({ enabled: false });
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

  it("takes the host's turn limit and refuses one that is not a count", () => {
    expect(
      readAgentSettings({ apiKey: "sk-test", maxConcurrentTurns: 16 })
    ).toMatchObject({ enabled: true, maxConcurrentTurns: 16 });
    for (const maxConcurrentTurns of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        readAgentSettings({ apiKey: "sk-test", maxConcurrentTurns })
      ).toThrow("agent.maxConcurrentTurns must be a positive integer");
    }
  });
});
