import {
  describeTwilioFailure,
  fetchTwilioAccount,
  readTwilioError,
} from "#src/twilio/client";
import { runVendorCall } from "#src/vendor-http";

export async function testTwilio(credentials: Record<string, string>) {
  const accountSid = credentials.TWILIO_ACCOUNT_SID;
  const authToken = credentials.TWILIO_AUTH_TOKEN;

  if (!(accountSid && authToken)) {
    return {
      success: false,
      error: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required",
    };
  }

  // A connection test answers the credentials UI over a Promise, so this is
  // where the effect is run and the transport provided. A step reaches Twilio
  // through the same client without any of that, because `defineStep` does it.
  const result = await runVendorCall(
    fetchTwilioAccount({ accountSid, authToken }),
    (error) => error
  );

  if (result.ok) {
    return { success: true };
  }

  const { failure } = result;

  // A request that never arrived has no HTTP status to report, so the transport
  // error is the whole story.
  if (failure._tag === "VendorUnreachable") {
    return {
      success: false,
      error: failure.message,
      details: { message: failure.message },
    };
  }

  const body =
    failure._tag === "VendorRejected"
      ? readTwilioError(failure.payload)
      : undefined;

  return {
    success: false,
    error: `API validation failed: HTTP ${failure.status}`,
    details: {
      status: failure.status,
      code: body?.code,
      moreInfo: body?.more_info,
      message: describeTwilioFailure(failure),
    },
  };
}
