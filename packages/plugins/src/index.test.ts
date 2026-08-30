import { checkIntegration } from "@wfgraph/core/plugin";
import { describe, expect, it } from "vitest";
import {
  builtInIntegrations,
  clerk,
  linear,
  posthog,
  resend,
  twilio,
} from "#src/index";

const integrations = builtInIntegrations();

/**
 * Every check `assembleExtensions` runs over an integration, run here over the real
 * six.
 *
 * A host finds out about a bad definition when its app starts, which is the right
 * place for a host and the wrong place for this repo: a description missing from one
 * field of one output schema would otherwise reach a reviewer as a green suite and an
 * adopter as a startup crash. `checkIntegration` is the function assembly itself
 * calls, exported for exactly this, and it throws naming the action -- so the line
 * below is a check as much as the cases are, and a bad definition fails this file's
 * collection.
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

  it("reuses immutable built-ins and keeps Slack options server-only", () => {
    const configured = builtInIntegrations({
      slack: {
        oauthClient: {
          clientId: "client-id",
          clientSecret: "client-secret",
        },
      },
    });

    expect(configured).not.toBe(integrations);
    expect(configured.map((integration) => integration.type)).toEqual(
      integrations.map((integration) => integration.type)
    );
    expect(configured[0]).toBe(clerk);
    expect(configured[1]).toBe(linear);
    expect(configured[2]).toBe(posthog);
    expect(configured[3]).toBe(resend);
    expect(configured[5]).toBe(twilio);
    expect(configured[4]).not.toHaveProperty("oauthClient");
    expect(JSON.stringify(configured)).not.toContain("client-secret");
  });

  // The field list is what the editor offers downstream nodes. Assembly counts it at
  // the root of the output schema, so a schema describing nothing is refused there;
  // this says the same thing per action, where a failure names which one.
  it.each(actions)("offers a field list for $id", ({ outputFields }) => {
    expect(outputFields).not.toHaveLength(0);
  });
});
