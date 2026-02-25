import { Resend } from "resend";

export async function testResend(credentials: Record<string, string>) {
  try {
    const apiKey = credentials.RESEND_API_KEY;

    if (!(apiKey && apiKey.startsWith("re_"))) {
      return {
        success: false,
        error: "Invalid API key format. Resend API keys start with 're_'",
      };
    }

    const resend = new Resend(apiKey);
    const { error } = await resend.domains.list();

    if (error) {
      // A send-only key returns "restricted_api_key" on non-send endpoints.
      // That confirms the key is valid — it just can't list domains, which is fine.
      if (error.name === "restricted_api_key") {
        return { success: true };
      }

      const details = {
        statusCode: error.statusCode,
        errorName: error.name,
        errorMessage: error.message,
      };

      if (error.statusCode === 401 || error.statusCode === 403) {
        return {
          success: false,
          error: "Invalid API key. Please check your Resend API key.",
          details,
        };
      }
      return {
        success: false,
        error: `API validation failed: HTTP ${error.statusCode ?? "unknown"}`,
        details,
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
