import { checkIntegration } from "@wfgraph/core/plugin";
import { describe, expect, it } from "vitest";
import { clerk } from "#src/clerk/index";
import { linear } from "#src/linear/index";
import { posthog } from "#src/posthog/index";
import { resend } from "#src/resend/index";
import { slack } from "#src/slack/index";
import { twilio } from "#src/twilio/index";

// Each integration's own module, which is the file its package entry builds from.
const integrations = [
  clerk(),
  linear(),
  posthog(),
  resend(),
  slack(),
  twilio(),
];

/**
 * Every check `assembleExtensions` runs over an integration, run here over the real
 * six.
 *
 * A host finds out about a bad definition when its app starts, which is the right
 * place for a host and the wrong place for this repo: a description missing from one
 * field of one output schema would otherwise reach a reviewer as a green suite and an
 * adopter as a startup crash. `checkIntegration` is the function assembly itself
 * calls, exported for exactly this, and it throws naming the offender. The
 * `actions` constant is therefore a check as much as the cases are, and a bad
 * definition fails this file's collection.
 */
const actions = integrations.flatMap((integration) =>
  checkIntegration(integration)
);

describe("every built-in integration", () => {
  it("covers all six", () => {
    expect(integrations.map((integration) => integration.type)).toEqual([
      "clerk",
      "linear",
      "posthog",
      "resend",
      "slack",
      "twilio",
    ]);
    expect(actions).not.toHaveLength(0);
  });

  // A host may call an integration function on every request, so the five that
  // take no options hand back the definition their module built when it loaded.
  it.each([
    ["clerk", clerk],
    ["linear", linear],
    ["posthog", posthog],
    ["resend", resend],
    ["twilio", twilio],
  ] as const)("%s returns the same definition on every call", (_, create) => {
    expect(create()).toBe(create());
  });

  it("keeps Slack's OAuth client credentials out of the catalog", () => {
    const configured = slack({
      oauthClient: {
        clientId: "client-id",
        clientSecret: "client-secret",
      },
    });

    expect(configured.oauth).toBeDefined();
    expect(configured).not.toHaveProperty("oauthClient");
    expect(JSON.stringify(configured)).not.toContain("client-secret");
  });

  // The field list is what the editor offers downstream nodes. Assembly counts it at
  // the root of the output schema, so a schema describing nothing is refused there;
  // this says the same thing per action, where a failure names which one.
  it.each(actions)("offers a field list for $id", ({ outputFields }) => {
    expect(outputFields).not.toHaveLength(0);
  });
});
