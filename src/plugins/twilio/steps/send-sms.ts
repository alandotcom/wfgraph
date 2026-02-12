
import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/steps/step-handler";
import type { TwilioCredentials } from "../credentials";

const TWILIO_API_URL = "https://api.twilio.com/2010-04-01";

type TwilioSendSmsResponse = {
  sid: string;
  status: string;
  to: string;
  from?: string;
  messaging_service_sid?: string;
  error_message?: string;
};

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

  const formData = new URLSearchParams();
  formData.set("To", input.smsTo);
  formData.set("Body", input.smsBody);

  if (senderFrom) {
    formData.set("From", senderFrom);
  }

  if (senderMessagingServiceSid) {
    formData.set("MessagingServiceSid", senderMessagingServiceSid);
  }

  if (input.smsStatusCallback) {
    formData.set("StatusCallback", input.smsStatusCallback);
  }

  const mediaUrls = parseMediaUrls(input.smsMediaUrls);
  for (const mediaUrl of mediaUrls) {
    formData.append("MediaUrl", mediaUrl);
  }

  try {
    const response = await fetch(
      `${TWILIO_API_URL}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData.toString(),
      }
    );

    const data = (await response.json()) as TwilioSendSmsResponse;

    if (!response.ok) {
      return {
        success: false,
        error: {
          message:
            data.error_message ||
            `HTTP ${response.status}: Failed to send SMS via Twilio`,
        },
      };
    }

    return {
      success: true,
      data: {
        sid: data.sid,
        status: data.status,
        to: data.to,
        from: data.from,
        messagingServiceSid: data.messaging_service_sid,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        message:
          error instanceof Error
            ? error.message
            : "Failed to send SMS via Twilio",
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
