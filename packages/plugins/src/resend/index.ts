/**
 * The Resend integration: its credentials, its one action, and what that action
 * takes and gives back.
 *
 * One file, because only the server imports it. The editor gets this plugin's
 * metadata as JSON over `/api/extensions`, so nothing here reaches a browser
 * bundle and the system client below costs the browser nothing. The icon is the
 * exception, since a React component cannot be serialized: it stays in `ui.ts`,
 * which only the browser imports.
 */

import {
  type CredentialFields,
  type CredentialsOf,
  defineIntegration,
  type JsonObject,
  StepFailure,
} from "@wfgraph/core/plugin";
import { omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import { Effect, Result, Schema } from "effect";
import { describeResendFailure, sendResendEmail } from "#src/resend/client";
import { resendOAuth } from "#src/resend/oauth";

const resendCredentialFields = {
  RESEND_API_KEY: {
    label: "API Key",
    type: "password",
    placeholder: "re_...",
    helpText: "Get your API key from ",
    helpLink: {
      text: "resend.com/api-keys",
      url: "https://resend.com/api-keys",
    },
  },
  RESEND_FROM_EMAIL: {
    label: "Default Sender",
    type: "text",
    placeholder: "Your Name <noreply@yourdomain.com>",
    helpText: "The name and email that will appear as the sender",
  },
} satisfies CredentialFields;

export type ResendCredentials = CredentialsOf<typeof resendCredentialFields>;

type ResendTestBehavior = "log_only" | "send_to_test_email";
const TEST_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The Send Email config, as the step reads it.
 *
 * Every field is a string because that is what a resolved config field is: the
 * editor writes text, and a template variable resolves to text. Which of them a
 * builder has to fill in is stated in `configFields`; what this schema says is
 * what the step may read. `optionalKey` for a field left blank, which reaches a
 * step as an absent key.
 */
const sendEmailInput = Schema.Struct({
  emailTo: Schema.String,
  emailSubject: Schema.String,
  emailFrom: Schema.optionalKey(Schema.String),
  emailBody: Schema.optionalKey(Schema.String),
  emailHtml: Schema.optionalKey(Schema.String),
  emailContentMode: Schema.optionalKey(Schema.String),
  emailTemplateId: Schema.optionalKey(Schema.String),
  /** JSON the workflow author typed, parsed by the step. */
  emailTemplateVariables: Schema.optionalKey(Schema.String),
  emailCc: Schema.optionalKey(Schema.String),
  emailBcc: Schema.optionalKey(Schema.String),
  emailReplyTo: Schema.optionalKey(Schema.String),
  emailScheduledAt: Schema.optionalKey(Schema.String),
  emailTopicId: Schema.optionalKey(Schema.String),
  /** JSON the workflow author typed, parsed by the step. */
  emailTags: Schema.optionalKey(Schema.String),
  testBehavior: Schema.optionalKey(Schema.String),
  testEmailTo: Schema.optionalKey(Schema.String),
});

/**
 * What a sent email leaves for the nodes downstream of it.
 *
 * `optionalKey(NullOr(...))` on the way out, which is the one spelling that survives
 * both a key the handler leaves out and a null it writes where the system sent
 * nothing.
 */
const sendEmailOutput = Schema.Struct({
  id: Schema.String.annotate({ description: "Email ID" }),
  /** Absent on a real send: this is why a test run did not make one. */
  reasonCode: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.annotate({ description: "Why a test run did not send" })
    )
  ),
});

function resolveResendTestBehavior(
  value: string | undefined
): ResendTestBehavior {
  return value === "send_to_test_email" ? "send_to_test_email" : "log_only";
}

function isValidTestEmailAddress(value: string): boolean {
  return TEST_EMAIL_PATTERN.test(value);
}

// Tags and template variables reach this step as JSON strings a workflow author
// typed into the node config, so both are parsed at that boundary. Text that does
// not describe what Resend accepts is logged and dropped, leaving the email to
// send without it. Both decodes ask for every issue rather than the first, so one
// log line accounts for the whole string the author typed.
const emailTagsSchema = Schema.mutable(
  Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String }))
);

const templateVariablesSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Finite])
);

const decodeEmailTags = Schema.decodeUnknownResult(emailTagsSchema, {
  errors: "all",
});

const decodeTemplateVariables = Schema.decodeUnknownResult(
  templateVariablesSchema,
  { errors: "all" }
);

function parseTags(tagsJson: string): typeof emailTagsSchema.Type | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(tagsJson);
  } catch (error) {
    console.error("[Resend] Failed to parse tags JSON:", error);
    return undefined;
  }

  const result = decodeEmailTags(parsed);

  if (Result.isFailure(result)) {
    console.error(
      "[Resend] Tags JSON must be a list of { name, value } entries:",
      result.failure.message
    );
    return undefined;
  }

  return result.success;
}

function parseTemplateVariables(
  templateVariables: string | undefined
): typeof templateVariablesSchema.Type | undefined {
  if (!templateVariables) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(templateVariables);
  } catch (error) {
    console.error("[Resend] Failed to parse template variables JSON:", error);
    return undefined;
  }

  const result = decodeTemplateVariables(parsed);

  if (Result.isFailure(result)) {
    console.error(
      "[Resend] Template variables JSON must map names to strings or numbers:",
      result.failure.message
    );
    return undefined;
  }

  return result.success;
}

/**
 * The body Resend is sent, or the failure that says why one could not be built.
 *
 * The three content modes differ only in which fields they add to a common set,
 * and each names the field it cannot do without, so the message tells an author
 * which box to fill in.
 */
function buildEmailPayload(
  input: typeof sendEmailInput.Type,
  senderEmail: string,
  recipients: { to: string; cc?: string; bcc?: string }
): Effect.Effect<JsonObject, StepFailure> {
  // Resend's own field names, which are snake_case on the wire.
  const basePayload: JsonObject = {
    from: senderEmail,
    to: recipients.to,
    subject: input.emailSubject,
    ...omitBy(
      {
        cc: recipients.cc,
        bcc: recipients.bcc,
        reply_to: input.emailReplyTo,
        scheduled_at: input.emailScheduledAt,
        topic_id: input.emailTopicId,
        tags: input.emailTags ? parseTags(input.emailTags) : undefined,
      },
      isNil
    ),
  };

  const contentMode = input.emailContentMode || "text";

  if (contentMode === "template") {
    return input.emailTemplateId
      ? Effect.succeed({
          ...basePayload,
          template: {
            id: input.emailTemplateId,
            ...omitBy(
              {
                variables: parseTemplateVariables(input.emailTemplateVariables),
              },
              isNil
            ),
          },
        })
      : Effect.fail(
          new StepFailure({
            message: "Template mode requires emailTemplateId.",
          })
        );
  }

  if (contentMode === "html") {
    return input.emailHtml
      ? Effect.succeed({
          ...basePayload,
          html: input.emailHtml,
          ...omitBy({ text: input.emailBody }, isNil),
        })
      : Effect.fail(
          new StepFailure({ message: "HTML mode requires emailHtml." })
        );
  }

  return input.emailBody
    ? Effect.succeed({
        ...basePayload,
        text: input.emailBody,
        ...omitBy({ html: input.emailHtml }, isNil),
      })
    : Effect.fail(
        new StepFailure({ message: "Text mode requires emailBody." })
      );
}

export const resend = () =>
  defineIntegration({
    type: "resend",
    label: "Resend",
    description: "Send transactional emails",
    credentials: resendCredentialFields,
    oauth: resendOAuth,

    test: async () => (await import("#src/resend/test")).testResend,

    actions: {
      "send-email": {
        label: "Send Email",
        description: "Send an email via Resend",
        sideEffect: true,
        input: sendEmailInput,
        output: sendEmailOutput,
        configFields: [
          {
            key: "emailFrom",
            label: "From (Sender)",
            type: "template-input",
            placeholder: "Your Name <noreply@example.com>",
            example: "Support <support@example.com>",
          },
          {
            key: "emailTo",
            label: "To",
            type: "template-input",
            placeholder: "recipient@example.com",
            example: "user@example.com",
            required: true,
          },
          {
            key: "testBehavior",
            label: "Test Mode Behavior",
            type: "select",
            defaultValue: "log_only",
            options: [
              { value: "log_only", label: "Log only (do nothing)" },
              { value: "send_to_test_email", label: "Send to test email" },
            ],
          },
          {
            key: "testEmailTo",
            label: "Test Email Address",
            type: "text",
            placeholder: "test@example.com",
            // Literal: a run's own payload must not steer the test send.
            literal: true,
            showWhen: {
              field: "testBehavior",
              equals: "send_to_test_email",
            },
          },
          {
            key: "emailSubject",
            label: "Subject",
            type: "template-input",
            placeholder: "Subject or {{NodeName.title}}",
            example: "Hello from my workflow",
            required: true,
          },
          {
            key: "emailContentMode",
            label: "Content Mode",
            type: "select",
            defaultValue: "text",
            options: [
              { value: "text", label: "Text" },
              { value: "html", label: "HTML" },
              { value: "template", label: "Template" },
            ],
          },
          {
            key: "emailBody",
            label: "Text Body",
            type: "template-textarea",
            placeholder: "Email content or {{NodeName.description}}",
            rows: 5,
            example: "This is the email body content.",
            required: true,
            showWhen: {
              field: "emailContentMode",
              equals: "text",
            },
          },
          {
            key: "emailHtml",
            label: "HTML Body",
            type: "template-textarea",
            placeholder: "<p>Hello {{NodeName.name}}</p>",
            rows: 8,
            showWhen: {
              field: "emailContentMode",
              equals: "html",
            },
          },
          {
            key: "emailTemplateId",
            label: "Template ID",
            type: "template-input",
            placeholder: "tpl_xxxxxxxx",
            showWhen: {
              field: "emailContentMode",
              equals: "template",
            },
          },
          {
            key: "emailTemplateVariables",
            label: "Template Variables (JSON)",
            type: "template-textarea",
            rows: 6,
            placeholder: '{"FIRST_NAME":"Alice","APPOINTMENT_AT":"2026-03-10"}',
            showWhen: {
              field: "emailContentMode",
              equals: "template",
            },
          },
          {
            type: "group",
            label: "Additional Recipients",
            fields: [
              {
                key: "emailCc",
                label: "CC",
                type: "template-input",
                placeholder: "cc@example.com",
                example: "manager@example.com",
              },
              {
                key: "emailBcc",
                label: "BCC",
                type: "template-input",
                placeholder: "bcc@example.com",
                example: "archive@example.com",
              },
              {
                key: "emailReplyTo",
                label: "Reply-To",
                type: "template-input",
                placeholder: "reply@example.com",
                example: "support@example.com",
              },
            ],
          },
          {
            type: "group",
            label: "Scheduling",
            fields: [
              {
                key: "emailScheduledAt",
                label: "Schedule At (ISO 8601)",
                type: "template-input",
                placeholder: "2024-12-25T09:00:00Z",
                example: "2024-12-25T09:00:00Z",
              },
              {
                key: "emailTopicId",
                label: "Topic ID",
                type: "template-input",
                placeholder: "topic_abc123",
                example: "topic_abc123",
              },
            ],
          },
          {
            type: "group",
            label: "Tags",
            fields: [
              {
                key: "emailTags",
                label: "",
                type: "key-value",
              },
            ],
          },
        ],
        handler: Effect.fn(function* (bag) {
          const { input } = bag;

          // The run's own id doubles as the idempotency key: a step Inngest
          // re-runs sends the same key, and Resend replays its first answer
          // rather than sending a second email.
          const idempotencyKey = bag.executionId;
          const syntheticIdSuffix = idempotencyKey ?? "no_execution";
          const testBehavior = resolveResendTestBehavior(input.testBehavior);

          // A test run either sends nothing at all or sends to one address the
          // user nominated. Both answers are a success carrying the reason, so
          // the run shows what happened rather than an error the user has to
          // interpret.
          if (bag.runMode === "test" && testBehavior === "log_only") {
            return {
              id: `resend:test-log-only:${syntheticIdSuffix}`,
              reasonCode: "test_mode_log_only",
            };
          }

          const testRecipient = input.testEmailTo?.trim() ?? "";
          const routeToTestRecipient =
            bag.runMode === "test" && testBehavior === "send_to_test_email";

          if (routeToTestRecipient && testRecipient.length === 0) {
            return {
              id: `resend:test-log-fallback:${syntheticIdSuffix}`,
              reasonCode: "test_mode_log_fallback_missing_test_email",
            };
          }

          if (routeToTestRecipient && !isValidTestEmailAddress(testRecipient)) {
            return {
              id: `resend:test-log-fallback:${syntheticIdSuffix}`,
              reasonCode: "test_mode_log_fallback_invalid_test_email",
            };
          }

          // Read late, so a test run deciding it has nothing to send never
          // touches the integration's secrets.
          const credentials = yield* bag.credentials;
          const apiKey = credentials.RESEND_API_KEY;

          if (!apiKey) {
            return yield* new StepFailure({
              message:
                "RESEND_API_KEY is not configured. Please add it in Project Integrations.",
            });
          }

          const senderEmail = input.emailFrom || credentials.RESEND_FROM_EMAIL;

          if (!senderEmail) {
            return yield* new StepFailure({
              message:
                "No sender is configured. Please add it in the action or in Project Integrations.",
            });
          }

          // A test send goes to the nominated address alone: carrying the real cc
          // and bcc over would mail the people the run was meant to spare.
          const payload = yield* buildEmailPayload(
            input,
            senderEmail,
            routeToTestRecipient
              ? { to: testRecipient }
              : { to: input.emailTo, cc: input.emailCc, bcc: input.emailBcc }
          );

          const sent = yield* bag.step.run(
            "send",
            sendResendEmail(apiKey, payload, idempotencyKey).pipe(
              Effect.mapError(
                (error) =>
                  new StepFailure({
                    message: `Failed to send email: ${describeResendFailure(error)}`,
                  })
              )
            )
          );

          return { id: sent.id };
        }),
      },
    },
  });
