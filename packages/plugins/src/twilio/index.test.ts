import { findActionById } from "@rova/shared/plugins/registry";
import { describe, expect, it } from "vitest";
import "#src/twilio/index";

/**
 * What a node downstream of a Send SMS node can reference.
 *
 * These paths used to be a list written out beside the action, with nothing
 * tying them to what the step returns. They are read off the step's output
 * schema now, which is the same schema the handler is typed against, so this
 * case is where the derivation is pinned: the three paths the hand-written list
 * carried keep their exact descriptions, and the three the step has always
 * returned and never offered are here too.
 *
 * Those three are `nullable`, which is what the schema says about a field the
 * handler may answer with nothing. The condition builder reads it and offers
 * the null checks, which is the right question to ask about a `from` number a
 * Messaging Service send never had.
 */
describe("twilio/send-sms output fields", () => {
  it("offers every field the step returns, described by the schema", () => {
    const action = findActionById("twilio/send-sms");

    expect(action?.outputFields).toEqual([
      { path: "sid", description: "Message SID", type: "string" },
      { path: "status", description: "Delivery status", type: "string" },
      { path: "to", description: "Recipient phone number", type: "string" },
      {
        path: "from",
        description: "Sender phone number",
        type: "string",
        nullable: true,
      },
      {
        path: "messagingServiceSid",
        description: "Messaging Service SID",
        type: "string",
        nullable: true,
      },
      {
        path: "reasonCode",
        description: "Why a test run did not send",
        type: "string",
        nullable: true,
      },
    ]);
  });
});
