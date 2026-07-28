import {
  fetchCredentials,
  type StepInput,
  withStepLogging,
} from "@rova/core/plugin";
import { createTwilioMessage, describeTwilioFailure } from "#src/twilio/client";
import type { TwilioCredentials } from "#src/twilio/credentials";

type SendSmsResult =
  | {
      success: true;
      data: {
        sid: string;
        status: string;
        to: string;
        from?: string;
        messagingServiceSid?: string;
        reasonCode?: string;
      };
    }
  | { success: false; error: { message: string } };

export type SendSmsCoreInput = {
  smsTo: string;
  smsBody: string;
  smsFrom?: string;
  smsMessagingServiceSid?: string;
  smsStatusCallback?: string;
  smsMediaUrls?: string;
};

export type SendSmsInput = StepInput &
  SendSmsCoreInput & {
    integrationId?: string;
    testBehavior?: string;
    testPhoneTo?: string;
  };

type TwilioTestBehavior = "log_only" | "send_to_test_phone";
const E164_PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

function resolveTwilioTestBehavior(value: unknown): TwilioTestBehavior {
  return value === "send_to_test_phone" ? "send_to_test_phone" : "log_only";
}

function isValidTestPhoneNumber(value: string): boolean {
  return E164_PHONE_PATTERN.test(value);
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

function validateSendSmsInput(input: SendSmsCoreInput): string | null {
  if (!(input.smsTo && input.smsBody)) {
    return "smsTo and smsBody are required";
  }

  return null;
}

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: SendSmsCoreInput,
  credentials: TwilioCredentials
): Promise<SendSmsResult> {
  const accountSid = credentials.TWILIO_ACCOUNT_SID;
  const authToken = credentials.TWILIO_AUTH_TOKEN;

  if (!(accountSid && authToken)) {
    return {
      success: false,
      error: {
        message:
          "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required. Add them in Project Integrations.",
      },
    };
  }

  const senderFrom = input.smsFrom || credentials.TWILIO_FROM_NUMBER;
  const senderMessagingServiceSid =
    input.smsMessagingServiceSid || credentials.TWILIO_MESSAGING_SERVICE_SID;

  if (!(senderFrom || senderMessagingServiceSid)) {
    return {
      success: false,
      error: {
        message:
          "Either From number or Messaging Service SID is required. Configure one in the action or integration settings.",
      },
    };
  }

  const validationError = validateSendSmsInput(input);
  if (validationError) {
    return {
      success: false,
      error: {
        message: validationError,
      },
    };
  }

  const mediaUrls = parseMediaUrls(input.smsMediaUrls);

  // Twilio's own parameter names, so this reads like its documentation. The
  // client drops the ones left undefined and expands MediaUrl into the repeated
  // key the form encoding uses for a list.
  const result = await createTwilioMessage(
    { accountSid, authToken },
    {
      To: input.smsTo,
      Body: input.smsBody,
      From: senderFrom || undefined,
      MessagingServiceSid: senderMessagingServiceSid || undefined,
      StatusCallback: input.smsStatusCallback || undefined,
      MediaUrl: mediaUrls.length > 0 ? mediaUrls : undefined,
    }
  );

  if (!result.ok) {
    return {
      success: false,
      error: { message: describeTwilioFailure(result.failure) },
    };
  }

  return {
    success: true,
    data: {
      sid: result.data.sid,
      status: result.data.status,
      to: result.data.to,
      from: result.data.from ?? undefined,
      messagingServiceSid: result.data.messaging_service_sid ?? undefined,
    },
  };
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function sendSmsStep(input: SendSmsInput): Promise<SendSmsResult> {
  const runMode = input._context?.runMode ?? "live";
  const testBehavior = resolveTwilioTestBehavior(input.testBehavior);
  const executionId = input._context?.executionId ?? "no_execution";

  if (runMode === "test" && testBehavior === "log_only") {
    return withStepLogging(input, async () => ({
      success: true,
      data: {
        sid: `twilio:test-log-only:${executionId}`,
        status: "queued",
        to: input.smsTo,
        reasonCode: "test_mode_log_only",
      },
    }));
  }

  const testPhoneRaw =
    typeof input.testPhoneTo === "string" ? input.testPhoneTo.trim() : "";
  const shouldRouteToTestPhone =
    runMode === "test" && testBehavior === "send_to_test_phone";

  if (shouldRouteToTestPhone && testPhoneRaw.length === 0) {
    return withStepLogging(input, async () => ({
      success: true,
      data: {
        sid: `twilio:test-log-fallback:${executionId}`,
        status: "queued",
        to: input.smsTo,
        reasonCode: "test_mode_log_fallback_missing_test_phone",
      },
    }));
  }

  if (shouldRouteToTestPhone && !isValidTestPhoneNumber(testPhoneRaw)) {
    return withStepLogging(input, async () => ({
      success: true,
      data: {
        sid: `twilio:test-log-fallback:${executionId}`,
        status: "queued",
        to: input.smsTo,
        reasonCode: "test_mode_log_fallback_invalid_test_phone",
      },
    }));
  }

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  const coreInput: SendSmsCoreInput = {
    ...input,
    smsTo: shouldRouteToTestPhone ? testPhoneRaw : input.smsTo,
  };

  return withStepLogging(input, () => stepHandler(coreInput, credentials));
}
