import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import { Effect } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
import * as twilioClient from "#src/twilio/client";
import { twilio } from "#src/twilio/index";

const underTest = twilio;

// What this step decides is whether and what to send, so the seam under it is
// the Twilio client. What that client puts on the wire is covered separately in
// twilio/client.test.ts, against a stubbed fetch. Spy rather than `vi.mock` so
// a worker that already evaluated this module still sees the stub.
const mocks = vi.hoisted(() => ({ createMessage: vi.fn() }));

const TWILIO_CREDENTIALS = {
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "auth-token",
  TWILIO_FROM_NUMBER: "+15551234567",
};

/**
 * The credentials a run would have fetched, and a count of the times the step
 * asked for them.
 *
 * A step hands its handler the fetch as an effect rather than a value, so a step
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
  vi.spyOn(twilioClient, "createTwilioMessage").mockImplementation(
    mocks.createMessage
  );
  vi.spyOn(twilioClient, "describeTwilioFailure").mockImplementation(
    (error: { message?: string }) => error.message ?? "twilio failure"
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The action as an integration binds it, which is the whole path a run takes:
 * the config decode, the credential fetch, the handler, the output encode and
 * the envelope. `input` is therefore the resolved config the engine builds,
 * which is the text a builder typed rather than what the schema decodes it to.
 */
describe("the send-sms action", () => {
  it.effect("logs only in test mode by default and skips external calls", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(underTest, "send-sms", {
          input: { smsTo: "+15550001111", smsBody: "Hello" },
          credentials,
          runMode: "test",
        })
      );

      expect(result).toEqual({
        sid: "twilio:test-log-only:no_execution",
        status: "queued",
        to: "+15550001111",
        reasonCode: "test_mode_log_only",
      });
      expect(reads.count).toBe(0);
      expect(mocks.createMessage).toHaveBeenCalledTimes(0);
    })
  );

  it.effect("routes to configured test phone in test mode", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(underTest, "send-sms", {
          input: {
            smsTo: "+15550001111",
            smsBody: "Hello",
            testBehavior: "send_to_test_phone",
            testPhoneTo: "  +15557654321 ",
          },
          credentials,
          runMode: "test",
        })
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
        messagingServiceSid: null,
      });
    })
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

        const result = actionData(
          yield* runAction(underTest, "send-sms", {
            input: {
              smsTo: "+15550001111",
              smsBody: "Hello",
              smsMessagingServiceSid: "MG999",
              smsStatusCallback: "https://example.com/status",
              // The comma-splitting is a transform on the input schema, so the
              // one line a builder typed reaches the handler as the list, with
              // the padding and the empty entry gone.
              smsMediaUrls:
                " https://example.com/a.png , ,https://example.com/b.png ",
            },
            credentials,
          })
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
          from: null,
          messagingServiceSid: "MG999",
        });
      })
  );

  it.effect("falls back to log-only when test phone is invalid", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(underTest, "send-sms", {
          input: {
            smsTo: "+15550001111",
            smsBody: "Hello",
            testBehavior: "send_to_test_phone",
            testPhoneTo: "not-a-phone",
          },
          credentials,
          runMode: "test",
        })
      );

      expect(result).toEqual({
        sid: "twilio:test-log-fallback:no_execution",
        status: "queued",
        to: "+15550001111",
        reasonCode: "test_mode_log_fallback_invalid_test_phone",
      });
      expect(reads.count).toBe(0);
      expect(mocks.createMessage).toHaveBeenCalledTimes(0);
    })
  );

  it.effect("fails with the message the system's refusal carries", () =>
    Effect.gen(function* () {
      mocks.createMessage.mockReturnValue(
        Effect.fail({ message: "Invalid parameter: To" })
      );
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(underTest, "send-sms", {
          input: { smsTo: "+15550001111", smsBody: "Hello" },
          credentials,
        })
      );

      expect(error.message).toBe("Invalid parameter: To");
    })
  );

  it.effect("says which credentials are missing before reaching Twilio", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({});

      const error = actionError(
        yield* runAction(underTest, "send-sms", {
          input: { smsTo: "+15550001111", smsBody: "Hello" },
          credentials,
        })
      );

      expect(error.message).toBe(
        "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required. Add them in Project Integrations."
      );
      expect(mocks.createMessage).toHaveBeenCalledTimes(0);
    })
  );

  it.effect("refuses a send with no sender configured anywhere", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({
        TWILIO_ACCOUNT_SID: "AC123",
        TWILIO_AUTH_TOKEN: "auth-token",
      });

      const error = actionError(
        yield* runAction(underTest, "send-sms", {
          input: { smsTo: "+15550001111", smsBody: "Hello" },
          credentials,
        })
      );

      expect(error.message).toBe(
        "Either From number or Messaging Service SID is required. Configure one in the action or integration settings."
      );
      expect(mocks.createMessage).toHaveBeenCalledTimes(0);
    })
  );

  // What pressing "Test" on a freshly configured Send SMS node does, with the
  // behaviour left at its default and no test phone typed in. The envelope is
  // asserted whole here, since that is what the engine reads.
  it.effect("answers the log-only success a default test run expects", () =>
    Effect.gen(function* () {
      const result = yield* runAction(underTest, "send-sms", {
        input: {
          smsTo: "+15550001111",
          smsBody: "Hello",
          testBehavior: "log_only",
        },
        runMode: "test",
        node: { executionId: "exec_1" },
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
    })
  );
});
