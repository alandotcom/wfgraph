/**
 * The Slack integration: its credentials, its one action, and what that action
 * does.
 *
 * One file, because only the server imports it. The editor gets this plugin's
 * metadata as JSON over `/api/extensions`, so nothing here reaches a browser
 * bundle. The icon is the exception, since a React component cannot be
 * serialized: it stays in `ui.ts`, which only the browser imports.
 */

import {
  type CredentialFields,
  type CredentialsOf,
  defineIntegration,
  StepFailure,
} from "@wfgraph/core/plugin";
import { Effect, Schema } from "effect";
import { callSlack, describeSlackFailure } from "#src/slack/client";
import { createSlackOAuth } from "#src/slack/oauth";

const slackCredentialFields = {
  SLACK_API_KEY: {
    label: "Bot Token",
    type: "password",
    placeholder: "xoxb-...",
    helpText: "Create a Slack app and get your Bot Token from ",
    helpLink: {
      text: "api.slack.com/apps",
      url: "https://api.slack.com/apps",
    },
  },
} satisfies CredentialFields;

export type SlackCredentials = CredentialsOf<typeof slackCredentialFields>;

export type SlackOptions = {
  oauthClient?: {
    clientId: string | undefined;
    clientSecret: string | undefined;
  };
};

type SlackTestBehavior = "log_only" | "send_message";

// What chat.postMessage answers with, as much of it as this step reports on.
const postMessageSchema = Schema.Struct({
  ts: Schema.String,
  channel: Schema.String,
});

/**
 * The Send Slack Message config, as the step reads it.
 *
 * Every field is a string because that is what a resolved config field is: the
 * editor writes text, and a template variable resolves to text. `optionalKey` for
 * a field a builder may leave blank, which reaches a step as an absent key.
 */
const sendSlackMessageInput = Schema.Struct({
  slackChannel: Schema.String,
  slackMessage: Schema.String,
  testBehavior: Schema.optionalKey(Schema.String),
});

/**
 * What a posted message leaves for the nodes downstream of it.
 *
 * `optionalKey(NullOr(...))` on the way out, which is the one spelling that survives
 * both a key the handler leaves out and a null it writes where the system sent
 * nothing.
 */
const sendSlackMessageOutput = Schema.Struct({
  ts: Schema.String.annotate({ description: "Message timestamp" }),
  channel: Schema.String.annotate({ description: "Channel ID" }),
  /** Absent on a real send: this is why a test run did not make one. */
  reasonCode: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.annotate({ description: "Why a test run did not send" })
    )
  ),
});

function resolveSlackTestBehavior(
  value: string | undefined
): SlackTestBehavior {
  return value === "send_message" ? "send_message" : "log_only";
}

export const slack = (options?: SlackOptions) => {
  const configuredClient = options?.oauthClient;
  const clientId = configuredClient?.clientId?.trim();
  const clientSecret = configuredClient?.clientSecret?.trim();

  if (configuredClient && (!clientId || !clientSecret)) {
    throw new Error(
      "Slack OAuth requires non-empty oauthClient.clientId and oauthClient.clientSecret."
    );
  }

  return defineIntegration({
    type: "slack",
    label: "Slack",
    description: "Send messages to Slack channels",
    credentials: slackCredentialFields,
    ...(clientId && clientSecret
      ? { oauth: createSlackOAuth(clientId, clientSecret) }
      : {}),

    // The connection test reaches Slack, so it stays behind a dynamic import until
    // someone presses "Test connection".
    test: async () => (await import("#src/slack/test")).testSlack,

    actions: {
      "send-message": {
        label: "Send Slack Message",
        description: "Send a message to a Slack channel",
        sideEffect: true,
        input: sendSlackMessageInput,
        output: sendSlackMessageOutput,
        configFields: [
          {
            key: "slackChannel",
            label: "Channel",
            type: "text",
            placeholder: "#general or {{NodeName.channel}}",
            example: "#general",
            required: true,
          },
          {
            key: "slackMessage",
            label: "Message",
            type: "template-textarea",
            placeholder:
              "Your message. Use {{NodeName.field}} to insert data from previous nodes.",
            rows: 4,
            example: "Hello from my workflow!",
            required: true,
          },
          {
            key: "testBehavior",
            label: "Test Mode Behavior",
            type: "select",
            defaultValue: "log_only",
            options: [
              { value: "log_only", label: "Log only (do nothing)" },
              { value: "send_message", label: "Send real Slack message" },
            ],
          },
        ],
        handler: Effect.fn(function* (bag) {
          const { input } = bag;
          const testBehavior = resolveSlackTestBehavior(input.testBehavior);

          // A test run posts nothing unless the builder asked it to. The answer
          // is a success carrying the reason, so the run shows what happened
          // rather than an error someone has to interpret.
          if (bag.runMode === "test" && testBehavior === "log_only") {
            return {
              ts: "",
              channel: input.slackChannel,
              reasonCode: "test_mode_log_only",
            };
          }

          // Read late, so a test run deciding it has nothing to post never
          // touches the integration's secrets.
          const credentials = yield* bag.credentials;
          const apiKey = credentials.SLACK_API_KEY;

          if (!apiKey) {
            return yield* new StepFailure({
              message:
                "SLACK_API_KEY is not configured. Please add it in Project Integrations.",
            });
          }

          const posted = yield* bag.step.run(
            "post",
            callSlack(apiKey, "chat.postMessage", postMessageSchema, {
              body: {
                channel: input.slackChannel,
                text: input.slackMessage,
              },
            }).pipe(
              Effect.mapError(
                (error) =>
                  new StepFailure({
                    message: `Failed to send Slack message: ${describeSlackFailure(error)}`,
                  })
              )
            )
          );

          return { ts: posted.ts, channel: posted.channel };
        }),
      },
    },
  });
};
