const ACUITY_API_URL = "https://acuityscheduling.com/api/v1";

export async function testAcuity(credentials: Record<string, string>) {
  try {
    const userId = credentials.ACUITY_USER_ID?.trim();
    const apiKey = credentials.ACUITY_API_KEY?.trim();

    if (!userId || !apiKey) {
      return {
        success: false,
        error: "ACUITY_USER_ID and ACUITY_API_KEY are required",
      };
    }

    const response = await fetch(`${ACUITY_API_URL}/calendars`, {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${userId}:${apiKey}`).toString("base64")}`,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return {
          success: false,
          error: "Invalid Acuity credentials. Please check your User ID and API key.",
        };
      }

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
