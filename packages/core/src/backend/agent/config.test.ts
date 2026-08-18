import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_MODEL,
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
      apiKey: "sk-test",
      model: DEFAULT_AGENT_MODEL,
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
      apiKey: "sk-test",
      model: "gpt-4.1",
      baseUrl: "https://gateway.example.test/v1",
    });
  });

  it("leaves baseUrl off rather than sending an empty one", () => {
    const settings = readAgentSettings({ apiKey: "sk-test", baseUrl: "" });

    expect(settings).not.toHaveProperty("baseUrl");
  });
});
