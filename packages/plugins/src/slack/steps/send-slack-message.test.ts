import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendSlackMessageStep } from "./send-slack-message";

// The step's job is deciding whether and what to send, so the seam under it is
// the Slack client. What that client puts on the wire is covered separately in
// slack/client.test.ts, against a stubbed fetch.
const mocks = vi.hoisted(() => {
  const fetchCredentials = vi.fn();
  const callSlack = vi.fn();

  return { fetchCredentials, callSlack };
});

// Both come from one module, so stubbing one means supplying the other.
vi.mock("@rova/core/plugin", () => ({
  fetchCredentials: mocks.fetchCredentials,
  withStepLogging: (_input: unknown, run: () => unknown) => run(),
}));

vi.mock("#src/slack/client", () => ({
  callSlack: mocks.callSlack,
  describeSlackFailure: (failure: { message?: string }) =>
    failure.message ?? "slack failure",
}));

describe("sendSlackMessageStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchCredentials.mockResolvedValue({
      SLACK_API_KEY: "xoxb-test-token",
    });
    mocks.callSlack.mockResolvedValue({
      ok: true,
      data: { ts: "1739.123", channel: "C12345" },
    });
  });

  it("logs only in test mode by default and skips external calls", async () => {
    const result = await sendSlackMessageStep({
      integrationId: "int_slack",
      slackChannel: "#alerts",
      slackMessage: "Hello world",
      _context: {
        nodeId: "n1",
        nodeName: "Slack",
        nodeType: "action",
        runMode: "test",
      },
    });

    expect(result).toEqual({
      success: true,
      ts: "",
      channel: "#alerts",
      reasonCode: "test_mode_log_only",
    });
    expect(mocks.fetchCredentials).toHaveBeenCalledTimes(0);
    expect(mocks.callSlack).toHaveBeenCalledTimes(0);
  });

  it("sends message in test mode when test behavior is send_message", async () => {
    const result = await sendSlackMessageStep({
      integrationId: "int_slack",
      slackChannel: "#alerts",
      slackMessage: "Hello world",
      testBehavior: "send_message",
      _context: {
        nodeId: "n1",
        nodeName: "Slack",
        nodeType: "action",
        runMode: "test",
      },
    });

    expect(mocks.fetchCredentials).toHaveBeenCalledWith("int_slack");
    expect(mocks.callSlack).toHaveBeenCalledWith(
      "xoxb-test-token",
      "chat.postMessage",
      expect.anything(),
      { channel: "#alerts", text: "Hello world" }
    );
    expect(result).toEqual({
      success: true,
      ts: "1739.123",
      channel: "C12345",
    });
  });

  it("does not suppress live mode even if test behavior is log_only", async () => {
    await sendSlackMessageStep({
      integrationId: "int_slack",
      slackChannel: "#alerts",
      slackMessage: "Hello world",
      testBehavior: "log_only",
      _context: {
        nodeId: "n1",
        nodeName: "Slack",
        nodeType: "action",
        runMode: "live",
      },
    });

    expect(mocks.fetchCredentials).toHaveBeenCalledWith("int_slack");
    expect(mocks.callSlack).toHaveBeenCalledTimes(1);
  });
});
