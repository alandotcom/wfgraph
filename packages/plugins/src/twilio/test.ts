import { describeTwilioFailure, fetchTwilioAccount } from "@/twilio/client";

export async function testTwilio(credentials: Record<string, string>) {
  const accountSid = credentials.TWILIO_ACCOUNT_SID;
  const authToken = credentials.TWILIO_AUTH_TOKEN;

  if (!(accountSid && authToken)) {
    return {
      success: false,
      error: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required",
    };
  }

  const result = await fetchTwilioAccount({ accountSid, authToken });

  if (result.ok) {
    return { success: true };
  }

  const { failure } = result;

  // A request that never arrived has no HTTP status to report, so the transport
  // error is the whole story.
  if (failure.kind === "unreachable") {
    return {
      success: false,
      error: failure.message,
      details: { message: failure.message },
    };
  }

  return {
    success: false,
    error: `API validation failed: HTTP ${failure.status}`,
    details: {
      status: failure.status,
      code: failure.kind === "rejected" ? failure.code : undefined,
      moreInfo: failure.kind === "rejected" ? failure.moreInfo : undefined,
      message: describeTwilioFailure(failure),
    },
  };
}
