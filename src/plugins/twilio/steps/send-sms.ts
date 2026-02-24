import { omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import twilio from "twilio";
import { fetchCredentials } from "@/backend/lib/credential-fetcher";
import {
  type StepInput,
  withStepLogging,
} from "@/backend/lib/steps/step-handler";
import type { TwilioCredentials } from "@/plugins/twilio/credentials";

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

type TwilioError = {
  status?: number;
  message?: string;
};

function getTwilioErrorMessage(error: unknown): string {
  if (error instanceof twilio.RestException) {
    return (
      error.message || `HTTP ${error.status}: Failed to send SMS via Twilio`
    );
  }

  if (error && typeof error === "object") {
    const twilioError = error as TwilioError;
    if (
      typeof twilioError.message === "string" &&
      twilioError.message.length > 0
    ) {
      return twilioError.message;
    }
    if (typeof twilioError.status === "number") {
      return `HTTP ${twilioError.status}: Failed to send SMS via Twilio`;
    }
  }

  return error instanceof Error
    ? error.message
    : "Failed to send SMS via Twilio";
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

  try {
    const twilioClient = twilio(accountSid, authToken);
    const message = await twilioClient.messages.create({
      to: input.smsTo,
      body: input.smsBody,
      ...omitBy(
        {
          from: senderFrom || undefined,
          messagingServiceSid: senderMessagingServiceSid || undefined,
          statusCallback: input.smsStatusCallback || undefined,
          mediaUrl: mediaUrls.length > 0 ? mediaUrls : undefined,
        },
        isNil
      ),
    });

    return {
      success: true,
      data: {
        sid: message.sid,
        status: message.status ?? "",
        to: message.to,
        from: message.from || undefined,
        messagingServiceSid: message.messagingServiceSid || undefined,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        message: getTwilioErrorMessage(error),
      },
    };
  }
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
sendSmsStep.maxRetries = 0;

// Export marker for codegen auto-generation
export const _integrationType = "twilio";
