import {
  defineStep,
  StepFailure,
  type StepRunContext,
} from "@rova/core/plugin";
import { Effect } from "effect";
import { createTwilioMessage, describeTwilioFailure } from "#src/twilio/client";
import type { TwilioCredentials } from "#src/twilio/credentials";
import { sendSmsInput, sendSmsOutput } from "#src/twilio/schemas";

type TwilioTestBehavior = "log_only" | "send_to_test_phone";
const E164_PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

function resolveTwilioTestBehavior(
  value: string | undefined
): TwilioTestBehavior {
  return value === "send_to_test_phone" ? "send_to_test_phone" : "log_only";
}

function parseMediaUrls(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies: what this step decides is which of five things to send, and every
 * one of those decisions is here.
 */
export const sendSmsHandler = Effect.fn(function* (
  input: typeof sendSmsInput.Type,
  context: StepRunContext
) {
  const executionId = context.executionId ?? "no_execution";
  const testBehavior = resolveTwilioTestBehavior(input.testBehavior);

  // A test run either sends nothing at all or sends to one number the user
  // nominated. Both answers are a success carrying the reason, so the run
  // shows what happened rather than an error the user has to interpret.
  if (context.runMode === "test" && testBehavior === "log_only") {
    return {
      sid: `twilio:test-log-only:${executionId}`,
      status: "queued",
      to: input.smsTo,
      reasonCode: "test_mode_log_only",
    };
  }

  const testPhone = input.testPhoneTo?.trim() ?? "";
  const routeToTestPhone =
    context.runMode === "test" && testBehavior === "send_to_test_phone";

  if (routeToTestPhone && testPhone.length === 0) {
    return {
      sid: `twilio:test-log-fallback:${executionId}`,
      status: "queued",
      to: input.smsTo,
      reasonCode: "test_mode_log_fallback_missing_test_phone",
    };
  }

  if (routeToTestPhone && !E164_PHONE_PATTERN.test(testPhone)) {
    return {
      sid: `twilio:test-log-fallback:${executionId}`,
      status: "queued",
      to: input.smsTo,
      reasonCode: "test_mode_log_fallback_invalid_test_phone",
    };
  }

  // The plugin's own credential vocabulary, so a key it never declares is a
  // compile error here rather than an undefined at run time.
  const credentials: TwilioCredentials = yield* context.credentials;
  const accountSid = credentials.TWILIO_ACCOUNT_SID;
  const authToken = credentials.TWILIO_AUTH_TOKEN;

  if (!(accountSid && authToken)) {
    return yield* Effect.fail(
      new StepFailure({
        message:
          "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required. Add them in Project Integrations.",
      })
    );
  }

  const senderFrom = input.smsFrom || credentials.TWILIO_FROM_NUMBER;
  const senderMessagingServiceSid =
    input.smsMessagingServiceSid || credentials.TWILIO_MESSAGING_SERVICE_SID;

  if (!(senderFrom || senderMessagingServiceSid)) {
    return yield* Effect.fail(
      new StepFailure({
        message:
          "Either From number or Messaging Service SID is required. Configure one in the action or integration settings.",
      })
    );
  }

  const recipient = routeToTestPhone ? testPhone : input.smsTo;

  if (!(recipient && input.smsBody)) {
    return yield* Effect.fail(
      new StepFailure({ message: "smsTo and smsBody are required" })
    );
  }

  const mediaUrls = parseMediaUrls(input.smsMediaUrls);

  // Twilio's own parameter names, so this reads like its documentation. The
  // client drops the ones left undefined and expands MediaUrl into the
  // repeated key the form encoding uses for a list.
  const message = yield* createTwilioMessage(
    { accountSid, authToken },
    {
      To: recipient,
      Body: input.smsBody,
      From: senderFrom || undefined,
      MessagingServiceSid: senderMessagingServiceSid || undefined,
      StatusCallback: input.smsStatusCallback || undefined,
      MediaUrl: mediaUrls.length > 0 ? mediaUrls : undefined,
    }
  ).pipe(
    Effect.mapError(
      (error) => new StepFailure({ message: describeTwilioFailure(error) })
    )
  );

  return {
    sid: message.sid,
    status: message.status,
    to: message.to,
    from: message.from ?? undefined,
    messagingServiceSid: message.messaging_service_sid ?? undefined,
  };
});

export const sendSmsStep = defineStep({
  id: "twilio/send-sms",
  input: sendSmsInput,
  output: sendSmsOutput,
  handler: sendSmsHandler,
});
