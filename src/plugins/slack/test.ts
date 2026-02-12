import { ErrorCode, WebClient } from "@slack/web-api";

type SlackWebApiError = {
  code?: ErrorCode;
  data?: { error?: string };
  statusCode?: number;
  message?: string;
};

export async function testSlack(credentials: Record<string, string>) {
  try {
    const apiKey = credentials.SLACK_API_KEY;

    if (!apiKey) {
      return {
        success: false,
        error: "SLACK_API_KEY is required",
      };
    }

    const slackClient = new WebClient(apiKey);
    await slackClient.auth.test();

    return { success: true };
  } catch (error) {
    if (error && typeof error === "object") {
      const slackError = error as SlackWebApiError;

      if (slackError.code === ErrorCode.PlatformError && slackError.data?.error) {
        return {
          success: false,
          error: slackError.data.error,
        };
      }

      if (
        slackError.code === ErrorCode.HTTPError &&
        typeof slackError.statusCode === "number"
      ) {
        return {
          success: false,
          error: `API validation failed: HTTP ${slackError.statusCode}`,
        };
      }
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
