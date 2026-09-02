import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import { Effect } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
import * as slackClient from "#src/slack/client";
import { slack } from "#src/slack/index";

const underTest = slack();

const mocks = vi.hoisted(() => ({ callSlack: vi.fn() }));

const SLACK_CREDENTIALS = { SLACK_API_KEY: "xoxb-test-token" };

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
    Effect.succeed({ ts: "1739.456", channel: "C12345" })
  );
  vi.spyOn(slackClient, "callSlack").mockImplementation(mocks.callSlack);
  vi.spyOn(slackClient, "describeSlackFailure").mockImplementation(
    (error: { message?: string }) => error.message ?? "slack failure"
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the reply-to-thread action", () => {
  it.effect("logs only in test mode by default and skips external calls", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(underTest, "reply-to-thread", {
          input: {
            slackChannel: "C12345",
            slackThreadTs: "1739.123",
            slackMessage: "Following up",
          },
          credentials,
          runMode: "test",
        })
      );

      expect(result).toEqual({
        ts: "",
        channel: "C12345",
        threadTs: "1739.123",
        reasonCode: "test_mode_log_only",
      });
      expect(reads.count).toBe(0);
      expect(mocks.callSlack).toHaveBeenCalledTimes(0);
    })
  );

  it.effect("posts a thread reply when test behavior is send_message", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(underTest, "reply-to-thread", {
          input: {
            slackChannel: "C12345",
            slackThreadTs: "1739.123",
            slackMessage: "Following up",
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
        {
          body: {
            channel: "C12345",
            text: "Following up",
            thread_ts: "1739.123",
          },
        }
      );
      expect(result).toEqual({
        ts: "1739.456",
        channel: "C12345",
        threadTs: "1739.123",
      });
    })
  );

  it.effect(
    "does not suppress live mode even if test behavior is log_only",
    () =>
      Effect.gen(function* () {
        const { credentials } = credentialsRead();

        yield* runAction(underTest, "reply-to-thread", {
          input: {
            slackChannel: "C12345",
            slackThreadTs: "1739.123",
            slackMessage: "Following up",
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
        Effect.fail({ message: "thread_not_found" })
      );
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(underTest, "reply-to-thread", {
          input: {
            slackChannel: "C12345",
            slackThreadTs: "missing",
            slackMessage: "Following up",
          },
          credentials,
        })
      );

      expect(error.message).toBe(
        "Failed to reply to Slack thread: thread_not_found"
      );
    })
  );

  it.effect("says which credential is missing before reaching Slack", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({});

      const error = actionError(
        yield* runAction(underTest, "reply-to-thread", {
          input: {
            slackChannel: "C12345",
            slackThreadTs: "1739.123",
            slackMessage: "Following up",
          },
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
