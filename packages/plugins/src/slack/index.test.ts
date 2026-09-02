import { requireOutputFieldsFromSchema } from "@wfgraph/core/plugin";
import { describe, expect, it } from "vitest";
import { slack } from "#src/slack/index";

const integration = slack();
const sendMessage = integration.actions["send-message"];
const replyToThread = integration.actions["reply-to-thread"];

describe("the slack integration", () => {
  it("declares its credentials and its actions as one value", () => {
    expect(integration.type).toBe("slack");
    expect(integration.test).toBeDefined();
    expect(Object.keys(integration.credentials)).toEqual(["SLACK_API_KEY"]);
    expect(Object.keys(integration.actions)).toEqual([
      "send-message",
      "reply-to-thread",
    ]);
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

  it("offers every thread reply field to downstream nodes", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Action "slack/reply-to-thread"',
        replyToThread.output
      )
    ).toEqual([
      { path: "ts", description: "Message timestamp", type: "string" },
      { path: "channel", description: "Channel ID", type: "string" },
      {
        path: "threadTs",
        description: "Parent message timestamp",
        type: "string",
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
