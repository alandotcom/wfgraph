import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { beforeEach, vi } from "vitest";
import { sendSlackMessageHandler } from "#src/slack/index";

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
 * `defineStep` hands the fetch over as an effect rather than a value, so a step
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

function contextFor(
  runMode: "live" | "test",
  credentials: Effect.Effect<Record<string, string | undefined>>
) {
  return {
    runMode,
    nodeId: "n1",
    nodeName: "Slack",
    nodeType: "action",
    integrationId: "int_slack",
    credentials,
  };
}

/** A step that succeeds fails the flip, which is what makes the test say so. */
const failure = Effect.flip;

// Nothing here reaches the network, because the client is stubbed above. The
// transport is provided all the same, since that is what a handler declares it
// needs and the compiler holds the test to it.
const withTransport = Effect.provide(FetchHttpClient.layer);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callSlack.mockReturnValue(
    Effect.succeed({ ts: "1739.123", channel: "C12345" })
  );
});

describe("sendSlackMessageHandler", () => {
  it.effect("logs only in test mode by default and skips external calls", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = yield* sendSlackMessageHandler(
        { slackChannel: "#alerts", slackMessage: "Hello world" },
        contextFor("test", credentials)
      );

      expect(result).toEqual({
        ts: "",
        channel: "#alerts",
        reasonCode: "test_mode_log_only",
      });
      expect(reads.count).toBe(0);
      expect(mocks.callSlack).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect(
    "sends message in test mode when test behavior is send_message",
    () =>
      Effect.gen(function* () {
        const { reads, credentials } = credentialsRead();

        const result = yield* sendSlackMessageHandler(
          {
            slackChannel: "#alerts",
            slackMessage: "Hello world",
            testBehavior: "send_message",
          },
          contextFor("test", credentials)
        );

        expect(reads.count).toBe(1);
        expect(mocks.callSlack).toHaveBeenCalledWith(
          "xoxb-test-token",
          "chat.postMessage",
          expect.anything(),
          { body: { channel: "#alerts", text: "Hello world" } }
        );
        expect(result).toEqual({ ts: "1739.123", channel: "C12345" });
      }).pipe(withTransport)
  );

  it.effect(
    "does not suppress live mode even if test behavior is log_only",
    () =>
      Effect.gen(function* () {
        const { credentials } = credentialsRead();

        yield* sendSlackMessageHandler(
          {
            slackChannel: "#alerts",
            slackMessage: "Hello world",
            testBehavior: "log_only",
          },
          contextFor("live", credentials)
        );

        expect(mocks.callSlack).toHaveBeenCalledTimes(1);
      }).pipe(withTransport)
  );

  it.effect("fails with the message the system's refusal carries", () =>
    Effect.gen(function* () {
      mocks.callSlack.mockReturnValue(
        Effect.fail({ message: "channel_not_found" })
      );
      const { credentials } = credentialsRead();

      const error = yield* failure(
        sendSlackMessageHandler(
          { slackChannel: "#nope", slackMessage: "Hello world" },
          contextFor("live", credentials)
        )
      );

      expect(error.message).toBe(
        "Failed to send Slack message: channel_not_found"
      );
    }).pipe(withTransport)
  );

  it.effect("says which credential is missing before reaching Slack", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({});

      const error = yield* failure(
        sendSlackMessageHandler(
          { slackChannel: "#alerts", slackMessage: "Hello world" },
          contextFor("live", credentials)
        )
      );

      expect(error.message).toBe(
        "SLACK_API_KEY is not configured. Please add it in Project Integrations."
      );
      expect(mocks.callSlack).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );
});
