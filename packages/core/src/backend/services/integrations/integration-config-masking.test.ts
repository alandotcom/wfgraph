import { describe, expect, it } from "vitest";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import {
  connectionDefaultsForBrowser,
  maskIntegrationConfig,
} from "#src/backend/services/integrations/integration-config-masking";

const slackLike = {
  type: "slack",
  label: "Slack",
  description: "test double",
  hasTest: false,
  hasWebhook: false,
  credentialFields: {
    apiKey: { label: "Bot Token", type: "password" },
    team: { label: "Team", type: "text" },
  },
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

  // The integration is absent whenever a host mounted Workflow Graph without it. With no
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

// One action naming `team` as the value its "Team" field falls back to, which is
// what makes that stored value drawable. `region` is stored and non-secret and is
// named by nothing, which is the case that separates this from "everything the
// mask let through".
const slackActions: ExtensionCatalog["actions"] = [
  {
    id: "slack.post-message",
    label: "Post Message",
    description: "test double",
    category: "Slack",
    integration: "slack",
    configFields: [
      {
        type: "group",
        label: "Destination",
        fields: [
          {
            key: "channel",
            label: "Channel",
            type: "template-input",
            connectionDefaultKey: "team",
          },
        ],
      },
      { key: "text", label: "Text", type: "template-input" },
    ],
    outputFields: [],
  },
];

const withSlackAction: ExtensionCatalog = {
  ...emptyExtensionCatalog,
  integrations: [
    {
      ...slackLike,
      credentialFields: {
        ...slackLike.credentialFields,
        region: { label: "Region", type: "text" },
      },
    },
  ],
  actions: slackActions,
};

describe("the connection values a config field may draw as its placeholder", () => {
  it("returns the value a field named, reaching inside a field group", () => {
    expect(
      connectionDefaultsForBrowser(withSlackAction, "slack", {
        apiKey: "xoxb-real-token",
        team: "acme",
        region: "us-east",
      })
    ).toEqual({ team: "acme" });
  });

  it("leaves out a stored value no field asked for", () => {
    expect(
      connectionDefaultsForBrowser(withSlackAction, "slack", {
        region: "us-east",
      })
    ).toEqual({});
  });

  // Defence in depth, not a state an assembled app reaches: `checkIntegration`
  // already refused a password key against this same declaration. Pinned so the
  // last gate before a value leaves the process is not deleted as dead code.
  it("refuses a secret key even though assembly cannot produce one", () => {
    const secretTeam: ExtensionCatalog = {
      ...withSlackAction,
      integrations: [
        {
          ...slackLike,
          credentialFields: {
            apiKey: { label: "Bot Token", type: "password" },
            team: { label: "Team", type: "password" },
          },
        },
      ],
    };

    expect(
      connectionDefaultsForBrowser(secretTeam, "slack", { team: "acme" })
    ).toEqual({});
  });

  it("answers nothing when the catalog does not hold the integration", () => {
    expect(
      connectionDefaultsForBrowser(emptyExtensionCatalog, "slack", {
        team: "acme",
      })
    ).toEqual({});
  });

  it("leaves out a key the connection has not filled in", () => {
    expect(
      connectionDefaultsForBrowser(withSlackAction, "slack", { team: "" })
    ).toEqual({});
  });
});
