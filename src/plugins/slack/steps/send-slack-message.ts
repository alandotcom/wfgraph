import { ErrorCode, WebClient } from "@slack/web-api";
import { fetchCredentials } from "@/backend/lib/credential-fetcher";
import {
  type StepInput,
  withStepLogging,
} from "@/backend/lib/steps/step-handler";
import type { SlackCredentials } from "@/plugins/slack/credentials";
import { getErrorMessage } from "@/shared/utils";

type SlackWebApiError = {
  code?: ErrorCode;
  data?: { error?: string };
  message?: string;
  statusCode?: number;
};

type SendSlackMessageResult =
  | { success: true; ts: string; channel: string }
  | { success: false; error: string };

export type SendSlackMessageCoreInput = {
  slackChannel: string;
  slackMessage: string;
};

export type SendSlackMessageInput = StepInput &
  SendSlackMessageCoreInput & {
    integrationId?: string;
  };

function getSlackErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return getErrorMessage(error);
  }

  const slackError = error as SlackWebApiError;

  if (slackError.code === ErrorCode.PlatformError && slackError.data?.error) {
    return slackError.data.error;
  }

  if (
    slackError.code === ErrorCode.HTTPError &&
    typeof slackError.statusCode === "number"
  ) {
    return `HTTP ${slackError.statusCode}`;
  }

  return slackError.message || getErrorMessage(error);
}

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: SendSlackMessageCoreInput,
  credentials: SlackCredentials
): Promise<SendSlackMessageResult> {
  const apiKey = credentials.SLACK_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error:
        "SLACK_API_KEY is not configured. Please add it in Project Integrations.",
    };
  }

  try {
    const slackClient = new WebClient(apiKey);
    const postSlackChatMessage = slackClient.chat.postMessage.bind(
      slackClient.chat
    );
    const result = await postSlackChatMessage({
      channel: input.slackChannel,
      text: input.slackMessage,
    });

    return {
      success: true,
      ts: result.ts || "",
      channel: typeof result.channel === "string" ? result.channel : "",
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to send Slack message: ${getSlackErrorMessage(error)}`,
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function sendSlackMessageStep(
  input: SendSlackMessageInput
): Promise<SendSlackMessageResult> {
  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
sendSlackMessageStep.maxRetries = 0;

export const _integrationType = "slack";
