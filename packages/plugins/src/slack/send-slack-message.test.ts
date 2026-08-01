import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@rova/core/testing";
import { Effect } from "effect";
import { beforeEach, vi } from "vitest";
import { slack } from "#src/slack/index";

// What this step decides is whether to post at all, so the seam under it is the
// Slack client. What that client puts on the wire is covered separately in
// slack/client.test.ts, against a stubbed fetch.
const mocks = vi.hoisted(() => ({ callSlack: vi.fn() }));

vi.mock("#src/slack/client", () => ({
  callSlack: mocks.callSlack,
  describeSlackFailure: (error: { message?: string }) =>
    error.message ?? "slack failure",
}));

const SLACK_CREDENTIALS = { SLACK_API_KEY: "xoxb-test-token" };

/**
 * The credentials a run would have fetched, and a count of the times the step
 * asked for them.
 *
 * A step hands its handler the fetch as an effect rather than a value, so a step
 * that decides it has nothing to send never reads the integration's secrets.
 * The count is what pins that.
 */
function credentialsRead(
  values: Record<string, string | undefined> = SLACK_CREDENTIALS
) {
  const reads = { count: 0 };

  return {
    reads,
    credentials: Effect.sync(() => {
      reads.count += 1;
      return values;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callSlack.mockReturnValue(
    Effect.succeed({ ts: "1739.123", channel: "C12345" })
  );
});

describe("the send-message action", () => {
  it.effect("logs only in test mode by default and skips external calls", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(slack, "send-message", {
          input: { slackChannel: "#alerts", slackMessage: "Hello world" },
          credentials,
          runMode: "test",
        })
      );

      expect(result).toEqual({
        ts: "",
        channel: "#alerts",
        reasonCode: "test_mode_log_only",
      });
      expect(reads.count).toBe(0);
      expect(mocks.callSlack).toHaveBeenCalledTimes(0);
    })
  );

  it.effect(
    "sends message in test mode when test behavior is send_message",
    () =>
      Effect.gen(function* () {
        const { reads, credentials } = credentialsRead();

        const result = actionData(
          yield* runAction(slack, "send-message", {
            input: {
              slackChannel: "#alerts",
              slackMessage: "Hello world",
              testBehavior: "send_message",
            },
            credentials,
            runMode: "test",
          })
        );

        expect(reads.count).toBe(1);
        expect(mocks.callSlack).toHaveBeenCalledWith(
          "xoxb-test-token",
          "chat.postMessage",
          expect.anything(),
          { body: { channel: "#alerts", text: "Hello world" } }
        );
        expect(result).toEqual({ ts: "1739.123", channel: "C12345" });
      })
  );

  it.effect(
    "does not suppress live mode even if test behavior is log_only",
    () =>
      Effect.gen(function* () {
        const { credentials } = credentialsRead();

        yield* runAction(slack, "send-message", {
          input: {
            slackChannel: "#alerts",
            slackMessage: "Hello world",
            testBehavior: "log_only",
          },
          credentials,
        });

        expect(mocks.callSlack).toHaveBeenCalledTimes(1);
      })
  );

  it.effect("fails with the message the system's refusal carries", () =>
    Effect.gen(function* () {
      mocks.callSlack.mockReturnValue(
        Effect.fail({ message: "channel_not_found" })
      );
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(slack, "send-message", {
          input: { slackChannel: "#nope", slackMessage: "Hello world" },
          credentials,
        })
      );

      expect(error.message).toBe(
        "Failed to send Slack message: channel_not_found"
      );
    })
  );

  it.effect("says which credential is missing before reaching Slack", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({});

      const error = actionError(
        yield* runAction(slack, "send-message", {
          input: { slackChannel: "#alerts", slackMessage: "Hello world" },
          credentials,
        })
      );

      expect(error.message).toBe(
        "SLACK_API_KEY is not configured. Please add it in Project Integrations."
      );
      expect(mocks.callSlack).toHaveBeenCalledTimes(0);
    })
  );
});
