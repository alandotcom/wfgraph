
import twilio from "twilio";
import { fetchCredentials } from "@/backend/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/backend/lib/steps/step-handler";
import type { TwilioCredentials } from "../credentials";

type SendSmsResult =
  | {
      success: true;
      data: {
        sid: string;
        status: string;
        to: string;
        from?: string;
        messagingServiceSid?: string;
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
  };

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
    return error.message || `HTTP ${error.status}: Failed to send SMS via Twilio`;
  }

  if (error && typeof error === "object") {
    const twilioError = error as TwilioError;
    if (typeof twilioError.message === "string" && twilioError.message.length > 0) {
      return twilioError.message;
    }
    if (typeof twilioError.status === "number") {
      return `HTTP ${twilioError.status}: Failed to send SMS via Twilio`;
    }
  }

  return error instanceof Error ? error.message : "Failed to send SMS via Twilio";
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

  if (!accountSid || !authToken) {
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

  if (!input.smsTo || !input.smsBody) {
    return {
      success: false,
      error: {
        message: "smsTo and smsBody are required",
      },
    };
  }

  const mediaUrls = parseMediaUrls(input.smsMediaUrls);

  try {
    const twilioClient = twilio(accountSid, authToken);
    const message = await twilioClient.messages.create({
      to: input.smsTo,
      body: input.smsBody,
      ...(senderFrom && { from: senderFrom }),
      ...(senderMessagingServiceSid && {
        messagingServiceSid: senderMessagingServiceSid,
      }),
      ...(input.smsStatusCallback && { statusCallback: input.smsStatusCallback }),
      ...(mediaUrls.length > 0 && { mediaUrl: mediaUrls }),
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

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
sendSmsStep.maxRetries = 0;

// Export marker for codegen auto-generation
export const _integrationType = "twilio";
