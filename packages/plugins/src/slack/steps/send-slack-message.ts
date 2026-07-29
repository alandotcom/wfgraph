import {
  defineStep,
  StepFailure,
  type StepRunContext,
} from "@rova/core/plugin";
import { Effect, Schema } from "effect";
import { callSlack, describeSlackFailure } from "#src/slack/client";
import type { SlackCredentials } from "#src/slack/credentials";
import {
  sendSlackMessageInput,
  sendSlackMessageOutput,
} from "#src/slack/schemas";

type SlackTestBehavior = "log_only" | "send_message";

// What chat.postMessage answers with, as much of it as this step reports on.
const postMessageSchema = Schema.Struct({
  ts: Schema.String,
  channel: Schema.String,
});

function resolveSlackTestBehavior(
  value: string | undefined
): SlackTestBehavior {
  return value === "send_message" ? "send_message" : "log_only";
}

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies: what this step decides is whether to post at all, and that decision
 * is here.
 */
export const sendSlackMessageHandler = Effect.fn(function* (
  input: typeof sendSlackMessageInput.Type,
  context: StepRunContext
) {
  const testBehavior = resolveSlackTestBehavior(input.testBehavior);

  // A test run posts nothing unless the user asked it to. The answer is a
  // success carrying the reason, so the run shows what happened rather than an
  // error the user has to interpret.
  if (context.runMode === "test" && testBehavior === "log_only") {
    return {
      ts: "",
      channel: input.slackChannel,
      reasonCode: "test_mode_log_only",
    };
  }

  // The plugin's own credential vocabulary, so a key it never declares is a
  // compile error here rather than an undefined at run time.
  const credentials: SlackCredentials = yield* context.credentials;
  const apiKey = credentials.SLACK_API_KEY;

  if (!apiKey) {
    return yield* Effect.fail(
      new StepFailure({
        message:
          "SLACK_API_KEY is not configured. Please add it in Project Integrations.",
      })
    );
  }

  const posted = yield* callSlack(
    apiKey,
    "chat.postMessage",
    postMessageSchema,
    {
      body: {
        channel: input.slackChannel,
        text: input.slackMessage,
      },
    }
  ).pipe(
    Effect.mapError(
      (error) =>
        new StepFailure({
          message: `Failed to send Slack message: ${describeSlackFailure(error)}`,
        })
    )
  );

  return { ts: posted.ts, channel: posted.channel };
});

export const sendSlackMessageStep = defineStep({
  id: "slack/send-message",
  input: sendSlackMessageInput,
  output: sendSlackMessageOutput,
  handler: sendSlackMessageHandler,
});
