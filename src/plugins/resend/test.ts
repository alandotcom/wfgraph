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
      if (error.statusCode === 401 || error.statusCode === 403) {
        return {
          success: false,
          error: "Invalid API key. Please check your Resend API key.",
        };
      }
      return {
        success: false,
        error: `API validation failed: HTTP ${error.statusCode ?? "unknown"}`,
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
