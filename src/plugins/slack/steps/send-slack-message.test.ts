import { beforeEach, describe, expect, it, mock, vi } from "bun:test";

const mocks = (() => {
  const fetchCredentials = vi.fn();
  const webClientCtor = vi.fn();
  const postMessage = vi.fn();

  return {
    fetchCredentials,
    webClientCtor,
    postMessage,
  };
})();

mock.module("@/backend/lib/credential-fetcher", () => ({
  fetchCredentials: mocks.fetchCredentials,
}));

mock.module("@slack/web-api", () => {
  class WebClient {
    chat = {
      postMessage: mocks.postMessage,
    };

    constructor(token: string) {
      mocks.webClientCtor(token);
    }
  }

  return {
    ErrorCode: {
      PlatformError: "platform_error",
      HTTPError: "http_error",
    },
    WebClient,
  };
});

const { sendSlackMessageStep } = await import("./send-slack-message");

describe("sendSlackMessageStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchCredentials.mockResolvedValue({
      SLACK_API_KEY: "xoxb-test-token",
    });
    mocks.postMessage.mockResolvedValue({
      ts: "1739.123",
      channel: "C12345",
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
    expect(mocks.postMessage).toHaveBeenCalledTimes(0);
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
    expect(mocks.webClientCtor).toHaveBeenCalledWith("xoxb-test-token");
    expect(mocks.postMessage).toHaveBeenCalledWith({
      channel: "#alerts",
      text: "Hello world",
    });
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
    expect(mocks.postMessage).toHaveBeenCalledTimes(1);
  });
});
