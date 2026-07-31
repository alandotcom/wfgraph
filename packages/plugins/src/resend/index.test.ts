import { requireOutputFieldsFromSchema } from "@rova/core/plugin";
import { describe, expect, it } from "vitest";
import { resend } from "#src/resend/index";

/**
 * What a node downstream of a Send Email node can reference.
 *
 * The one path the hand-written list carried keeps its exact description, and
 * `reasonCode` -- which a test run has always answered with and never offered
 * -- is here too.
 */
describe("the resend integration", () => {
  it("declares its credentials and its actions as one value", () => {
    expect(resend.type).toBe("resend");
    expect(resend.test).toBeDefined();
    expect(resend.credentials.map((field) => field.envVar)).toEqual([
      "RESEND_API_KEY",
      "RESEND_FROM_EMAIL",
    ]);
    expect(Object.keys(resend.actions)).toEqual(["send-email"]);
  });

  it("offers every field the step returns, described by the schema", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Action "resend/send-email"',
        resend.actions["send-email"].output
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
