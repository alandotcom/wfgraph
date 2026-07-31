import { describe, expect, it } from "vitest";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@rova/shared/extensions/catalog";
import { maskIntegrationConfig } from "#src/backend/services/integrations/integration-config-masking";

const slackLike = {
  type: "slack",
  label: "Slack",
  description: "test double",
  hasTest: false,
  credentialFields: [
    { id: "apiKey", label: "Bot Token", type: "password", configKey: "apiKey" },
    { id: "team", label: "Team", type: "text", configKey: "team" },
  ],
} as const;

const withSlack: ExtensionCatalog = {
  ...emptyExtensionCatalog,
  integrations: [slackLike],
};

describe("masking an integration config on its way to the browser", () => {
  it("masks the fields the integration declared as secrets", () => {
    expect(
      maskIntegrationConfig(withSlack, "slack", {
        apiKey: "xoxb-real-token",
        team: "acme",
      })
    ).toEqual({ apiKey: "********", team: "acme" });
  });

  // The integration is absent whenever a host mounted Rova without it. With no
  // declaration to read, every value is treated as a secret; the alternative
  // served a live API token to the browser.
  it("masks everything when the catalog does not hold the integration", () => {
    expect(
      maskIntegrationConfig(emptyExtensionCatalog, "slack", {
        apiKey: "xoxb-real-token",
        team: "acme",
      })
    ).toEqual({ apiKey: "********", team: "********" });
  });
});
