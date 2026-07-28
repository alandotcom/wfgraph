import {
  fetchCredentials,
  type StepInput,
  withStepLogging,
} from "@rova/core/plugin";
import type { StepError } from "@rova/shared/workflow/step-result";
import { Schema } from "effect";
import { callSlack, describeSlackFailure } from "#src/slack/client";
import type { SlackCredentials } from "#src/slack/credentials";

type SendSlackMessageResult =
  | { success: true; ts: string; channel: string; reasonCode?: string }
  | { success: false; error: StepError };

export type SendSlackMessageCoreInput = {
  slackChannel: string;
  slackMessage: string;
};

type SlackTestBehavior = "log_only" | "send_message";

// What chat.postMessage answers with, as much of it as this step reports on.
const postMessageSchema = Schema.Struct({
  ts: Schema.String,
  channel: Schema.String,
});

export type SendSlackMessageInput = StepInput &
  SendSlackMessageCoreInput & {
    integrationId?: string;
    testBehavior?: string;
  };

function resolveSlackTestBehavior(value: unknown): SlackTestBehavior {
  return value === "send_message" ? "send_message" : "log_only";
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
      error: {
        message:
          "SLACK_API_KEY is not configured. Please add it in Project Integrations.",
      },
    };
  }

  const result = await callSlack(
    apiKey,
    "chat.postMessage",
    postMessageSchema,
    {
      channel: input.slackChannel,
      text: input.slackMessage,
    }
  );

  if (!result.ok) {
    return {
      success: false,
      error: {
        message: `Failed to send Slack message: ${describeSlackFailure(result.failure)}`,
      },
    };
  }

  return {
    success: true,
    ts: result.data.ts,
    channel: result.data.channel,
  };
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function sendSlackMessageStep(
  input: SendSlackMessageInput
): Promise<SendSlackMessageResult> {
  const runMode = input._context?.runMode ?? "live";
  const testBehavior = resolveSlackTestBehavior(input.testBehavior);

  if (runMode === "test" && testBehavior === "log_only") {
    return withStepLogging(input, async () => ({
      success: true,
      ts: "",
      channel: input.slackChannel,
      reasonCode: "test_mode_log_only",
    }));
  }

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
