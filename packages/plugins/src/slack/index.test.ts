import { requireOutputFieldsFromSchema } from "@rova/shared/workflow/output-fields";
import { describe, expect, it } from "vitest";
import { slack } from "#src/slack/index";

const sendMessage = slack.actions["send-message"];

describe("the slack integration", () => {
  it("declares its credentials and its actions as one value", () => {
    expect(slack.type).toBe("slack");
    expect(slack.test).toBeDefined();
    expect(slack.credentials.map((field) => field.envVar)).toEqual([
      "SLACK_API_KEY",
    ]);
    expect(Object.keys(slack.actions)).toEqual(["send-message"]);
  });

  /**
   * What a node downstream of a Send Slack Message node can reference.
   *
   * The two paths the hand-written list carried keep their exact descriptions,
   * and `reasonCode` -- which a test run has always answered with and never
   * offered -- is here too.
   */
  it("offers every field the step returns, described by the schema", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Action "slack/send-message"',
        sendMessage.output
      )
    ).toEqual([
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
