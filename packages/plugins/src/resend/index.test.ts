import { findActionById } from "@rova/shared/plugins/registry";
import { describe, expect, it } from "vitest";
import "#src/resend/index";

/**
 * What a node downstream of a Send Email node can reference.
 *
 * The one path the hand-written list carried keeps its exact description, and
 * `reasonCode` -- which a test run has always answered with and never offered
 * -- is here too.
 */
describe("resend/send-email output fields", () => {
  it("offers every field the step returns, described by the schema", () => {
    const action = findActionById("resend/send-email");

    expect(action?.outputFields).toEqual([
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
