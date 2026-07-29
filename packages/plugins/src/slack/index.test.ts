import { findActionById } from "@rova/shared/plugins/registry";
import { describe, expect, it } from "vitest";
import "#src/slack/index";

/**
 * What a node downstream of a Send Slack Message node can reference.
 *
 * The two paths the hand-written list carried keep their exact descriptions,
 * and `reasonCode` -- which a test run has always answered with and never
 * offered -- is here too.
 */
describe("slack/send-message output fields", () => {
  it("offers every field the step returns, described by the schema", () => {
    const action = findActionById("slack/send-message");

    expect(action?.outputFields).toEqual([
      { path: "ts", description: "Message timestamp", type: "string" },
      { path: "channel", description: "Channel ID", type: "string" },
      {
        path: "reasonCode",
        description: "Why a test run did not send",
        type: "string",
        nullable: true,
      },
    ]);
  });
});
