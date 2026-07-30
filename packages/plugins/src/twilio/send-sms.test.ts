import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { beforeEach, vi } from "vitest";
import { sendSmsHandler, twilio } from "#src/twilio/index";

// What this step decides is whether and what to send, so the seam under it is
// the Twilio client. What that client puts on the wire is covered separately in
// twilio/client.test.ts, against a stubbed fetch.
const mocks = vi.hoisted(() => ({ createMessage: vi.fn() }));

vi.mock("#src/twilio/client", () => ({
  createTwilioMessage: mocks.createMessage,
  describeTwilioFailure: (error: { message?: string }) =>
    error.message ?? "twilio failure",
}));

const TWILIO_CREDENTIALS = {
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "auth-token",
  TWILIO_FROM_NUMBER: "+15551234567",
};

/**
 * The credentials a run would have fetched, and a count of the times the step
 * asked for them.
 *
 * `defineStep` hands the fetch over as an effect rather than a value, so a step
 * that decides it has nothing to send never reads the integration's secrets.
 * The count is what pins that.
 */
function credentialsRead(
  values: Record<string, string | undefined> = TWILIO_CREDENTIALS
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
    nodeName: "SMS",
    nodeType: "action",
    integrationId: "int_twilio",
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
  // Answer the way Twilio does, in its own snake_case, so the step's reading of
  // the response is exercised rather than assumed.
  mocks.createMessage.mockImplementation(
    (_credentials: unknown, parameters: Record<string, string | undefined>) =>
      Effect.succeed({
        sid: "SM123",
        status: "queued",
        to: parameters.To,
        from: parameters.From ?? null,
        messaging_service_sid: parameters.MessagingServiceSid ?? null,
      })
  );
});

describe("sendSmsHandler", () => {
  it.effect("logs only in test mode by default and skips external calls", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = yield* sendSmsHandler(
        { smsTo: "+15550001111", smsBody: "Hello" },
        contextFor("test", credentials)
      );

      expect(result).toEqual({
        sid: "twilio:test-log-only:no_execution",
        status: "queued",
        to: "+15550001111",
        reasonCode: "test_mode_log_only",
      });
      expect(reads.count).toBe(0);
      expect(mocks.createMessage).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("routes to configured test phone in test mode", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = yield* sendSmsHandler(
        {
          smsTo: "+15550001111",
          smsBody: "Hello",
          testBehavior: "send_to_test_phone",
          testPhoneTo: "  +15557654321 ",
        },
        contextFor("test", credentials)
      );

      expect(reads.count).toBe(1);
      expect(mocks.createMessage).toHaveBeenCalledWith(
        { accountSid: "AC123", authToken: "auth-token" },
        {
          To: "+15557654321",
          Body: "Hello",
          From: "+15551234567",
          MessagingServiceSid: undefined,
          StatusCallback: undefined,
          MediaUrl: undefined,
        }
      );
      expect(result).toEqual({
        sid: "SM123",
        status: "queued",
        to: "+15557654321",
        from: "+15551234567",
        messagingServiceSid: undefined,
      });
    }).pipe(withTransport)
  );

  // The REST names differ from the SDK's camelCase options, and the response
  // key is snake_case. A typo in either is silent: the parameter is dropped or
  // the field reads as absent.
  it.effect(
    "sends Twilio's own parameter names and reads its own response keys",
    () =>
      Effect.gen(function* () {
        const { credentials } = credentialsRead({
          TWILIO_ACCOUNT_SID: "AC123",
          TWILIO_AUTH_TOKEN: "auth-token",
        });

        const result = yield* sendSmsHandler(
          {
            smsTo: "+15550001111",
            smsBody: "Hello",
            smsMessagingServiceSid: "MG999",
            smsStatusCallback: "https://example.com/status",
            // The comma-splitting is a transform on the input schema, so what a
            // handler receives is the list rather than the text a builder typed.
            smsMediaUrls: [
              "https://example.com/a.png",
              "https://example.com/b.png",
            ],
          },
          contextFor("live", credentials)
        );

        expect(mocks.createMessage).toHaveBeenCalledWith(
          { accountSid: "AC123", authToken: "auth-token" },
          {
            To: "+15550001111",
            Body: "Hello",
            From: undefined,
            MessagingServiceSid: "MG999",
            StatusCallback: "https://example.com/status",
            MediaUrl: [
              "https://example.com/a.png",
              "https://example.com/b.png",
            ],
          }
        );
        expect(result).toEqual({
          sid: "SM123",
          status: "queued",
          to: "+15550001111",
          from: undefined,
          messagingServiceSid: "MG999",
        });
      }).pipe(withTransport)
  );

  it.effect("falls back to log-only when test phone is invalid", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = yield* sendSmsHandler(
        {
          smsTo: "+15550001111",
          smsBody: "Hello",
          testBehavior: "send_to_test_phone",
          testPhoneTo: "not-a-phone",
        },
        contextFor("test", credentials)
      );

      expect(result).toEqual({
        sid: "twilio:test-log-fallback:no_execution",
        status: "queued",
        to: "+15550001111",
        reasonCode: "test_mode_log_fallback_invalid_test_phone",
      });
      expect(reads.count).toBe(0);
      expect(mocks.createMessage).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("fails with the message the vendor's refusal carries", () =>
    Effect.gen(function* () {
      mocks.createMessage.mockReturnValue(
        Effect.fail({ message: "Invalid parameter: To" })
      );
      const { credentials } = credentialsRead();

      const error = yield* failure(
        sendSmsHandler(
          { smsTo: "+15550001111", smsBody: "Hello" },
          contextFor("live", credentials)
        )
      );

      expect(error.message).toBe("Invalid parameter: To");
    }).pipe(withTransport)
  );

  it.effect("says which credentials are missing before reaching Twilio", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({});

      const error = yield* failure(
        sendSmsHandler(
          { smsTo: "+15550001111", smsBody: "Hello" },
          contextFor("live", credentials)
        )
      );

      expect(error.message).toBe(
        "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required. Add them in Project Integrations."
      );
      expect(mocks.createMessage).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("refuses a send with no sender configured anywhere", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({
        TWILIO_ACCOUNT_SID: "AC123",
        TWILIO_AUTH_TOKEN: "auth-token",
      });

      const error = yield* failure(
        sendSmsHandler(
          { smsTo: "+15550001111", smsBody: "Hello" },
          contextFor("live", credentials)
        )
      );

      expect(error.message).toBe(
        "Either From number or Messaging Service SID is required. Configure one in the action or integration settings."
      );
      expect(mocks.createMessage).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );
});

/**
 * The step as `assembleExtensions` binds it, which is the whole path a run takes:
 * the config decode, the handler, and the envelope. The credential fetch is the
 * one thing not exercised here, because a test run in log-only mode decides it has
 * nothing to send before asking for a secret.
 *
 * The default test run is the case that matters. It is what pressing "Test" on a
 * freshly configured Send SMS node does, with the behaviour left at its default and
 * no test phone typed in, and the config the engine builds for it carries only the
 * keys the node holds a value for.
 */
describe("the send-sms step as an integration binds it", () => {
  const run = twilio.actions["send-sms"].implement("twilio/send-sms");

  it("answers the log-only success a default test run expects", async () => {
    const result = await run({
      actionType: "twilio/send-sms",
      smsTo: "+15550001111",
      smsBody: "Hello",
      testBehavior: "log_only",
      _context: {
        executionId: "exec_1",
        nodeId: "n1",
        nodeName: "SMS",
        nodeType: "twilio/send-sms",
        runMode: "test",
      },
    });

    expect(result).toEqual({
      success: true,
      data: {
        sid: "twilio:test-log-only:exec_1",
        status: "queued",
        to: "+15550001111",
        reasonCode: "test_mode_log_only",
      },
    });
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });

  // Read through the step's own input schema, which is the object its config
  // decode runs: one text field carries the list, and the handler receives the
  // list rather than the text a builder typed.
  it("splits the Media URLs field a builder typed as one line", () => {
    const decodeConfig = Schema.decodeUnknownSync(
      Schema.toCodecJson(twilio.actions["send-sms"].input)
    );

    expect(
      decodeConfig({
        smsTo: "+15550001111",
        smsBody: "Hello",
        smsMediaUrls:
          " https://example.com/a.png , ,https://example.com/b.png ",
      })
    ).toEqual({
      smsTo: "+15550001111",
      smsBody: "Hello",
      smsMediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
    });
  });
});
