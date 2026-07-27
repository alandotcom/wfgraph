import { afterEach, describe, expect, it } from "bun:test";
import { registerIntegration, unregisterIntegration } from "@/plugins/registry";
import type { IntegrationPlugin } from "@/plugins/registry";
import { maskIntegrationConfig } from "./integration-config-masking";

const slackLike: IntegrationPlugin = {
  type: "slack",
  label: "Slack",
  description: "test double",
  formFields: [
    { id: "apiKey", label: "Bot Token", type: "password", configKey: "apiKey" },
    { id: "team", label: "Team", type: "text", configKey: "team" },
  ],
  actions: [],
};

afterEach(() => {
  unregisterIntegration("slack");
});

describe("masking an integration config on its way to the browser", () => {
  it("masks the fields the plugin declared as secrets", () => {
    registerIntegration(slackLike);

    expect(
      maskIntegrationConfig("slack", {
        apiKey: "xoxb-real-token",
        team: "acme",
      })
    ).toEqual({ apiKey: "********", team: "acme" });
  });

  // The plugin is absent whenever a host mounted Rova without @rova/plugins or
  // disabled the plugin. With no declaration to read, every value is treated as
  // a secret; the alternative served a live API token to the browser.
  it("masks everything when the plugin is not registered", () => {
    expect(
      maskIntegrationConfig("slack", {
        apiKey: "xoxb-real-token",
        team: "acme",
      })
    ).toEqual({ apiKey: "********", team: "********" });
  });
});
