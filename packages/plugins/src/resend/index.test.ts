import { requireOutputFieldsFromSchema } from "@wfgraph/core/plugin";
import { describe, expect, it } from "vitest";
import { resend } from "#src/resend/index";

const integration = resend();

/**
 * What a node downstream of a Send Email node can reference.
 *
 * The one path the hand-written list carried keeps its exact description, and
 * `reasonCode` -- which a test run has always answered with and never offered
 * -- is here too.
 */
describe("the resend integration", () => {
  it("declares its credentials and its actions as one value", () => {
    expect(integration.type).toBe("resend");
    expect(integration.test).toBeDefined();
    expect(Object.keys(integration.credentials)).toEqual([
      "RESEND_API_KEY",
      "RESEND_FROM_EMAIL",
    ]);
    expect(Object.keys(integration.actions)).toEqual(["send-email"]);
  });

  it("declares Resend's provider-owned OAuth adapter", () => {
    expect(integration.oauth).toBeDefined();
    expect(integration.oauth?.label).toBe("Resend");
    expect(integration.oauth?.pkce).toBe("S256");
  });

  it("offers every field the step returns, described by the schema", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Action "resend/send-email"',
        integration.actions["send-email"].output
      )
    ).toEqual([
      { path: "id", description: "Email ID", type: "string" },
      {
        path: "reasonCode",
        description: "Why a test run did not send",
        type: "string",
        nullable: true,
      },
    ]);
  });
});
