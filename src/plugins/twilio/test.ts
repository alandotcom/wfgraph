const TWILIO_API_URL = "https://api.twilio.com/2010-04-01";

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

    const response = await fetch(
      `${TWILIO_API_URL}/Accounts/${encodeURIComponent(accountSid)}.json`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        },
      }
    );

    if (!response.ok) {
      return {
        success: false,
        error: `API validation failed: HTTP ${response.status}`,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
