import twilio from "twilio";

type TwilioError = {
  status?: number;
  message?: string;
};

export async function testTwilio(credentials: Record<string, string>) {
  try {
    const accountSid = credentials.TWILIO_ACCOUNT_SID;
    const authToken = credentials.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      return {
        success: false,
        error: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required",
      };
    }

    const twilioClient = twilio(accountSid, authToken);
    await twilioClient.api.v2010.accounts(accountSid).fetch();

    return { success: true };
  } catch (error) {
    if (error instanceof twilio.RestException) {
      return {
        success: false,
        error: `API validation failed: HTTP ${error.status}`,
      };
    }

    if (error && typeof error === "object") {
      const twilioError = error as TwilioError;
      if (typeof twilioError.status === "number") {
        return {
          success: false,
          error: `API validation failed: HTTP ${twilioError.status}`,
        };
      }
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
