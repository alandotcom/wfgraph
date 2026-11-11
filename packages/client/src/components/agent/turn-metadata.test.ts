import { describe, expect, it } from "vitest";
import {
  readTurnMetadata,
  usageSummary,
} from "#src/components/agent/turn-metadata";

const usage = {
  type: "usage" as const,
  modelCalls: 3,
  toolCalls: 1,
  inputTokens: 12_000,
  cachedInputTokens: 8_000,
  outputTokens: 400,
  reasoningTokens: 100,
};

describe("readTurnMetadata", () => {
  it("reads the usage a turn recorded", () => {
    expect(readTurnMetadata({ usage })).toEqual({ usage });
  });

  it("reads a record it cannot decode as empty", () => {
    expect(readTurnMetadata({ usage: { type: "usage" } })).toEqual({});
    expect(readTurnMetadata(undefined)).toEqual({});
  });
});

describe("usageSummary", () => {
  it("names calls and tokens, with the cached share", () => {
    expect(usageSummary(usage)).toBe(
      "3 model calls · 1 tool call · 12.4K tokens (8K cached)"
    );
  });

  it("leaves the cached share out when nothing was cached", () => {
    expect(
      usageSummary({ ...usage, modelCalls: 1, cachedInputTokens: 0 })
    ).toBe("1 model call · 1 tool call · 12.4K tokens");
  });
});
