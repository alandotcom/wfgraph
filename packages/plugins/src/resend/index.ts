/**
 * The Resend integration: its credentials, its one action, and what that action
 * takes and gives back.
 *
 * The handler lives in `steps/send-email.ts` and arrives through `load`, because
 * what it does -- three content modes, two JSON fields a builder typed, a test
 * mode with its own destination -- is long enough to want a file of its own. The
 * schemas are exported for that module to type itself against.
 *
 * Only the server imports this. The editor gets the metadata below as JSON over
 * `/api/extensions`, and the icon stays in `ui.ts`.
 */

import {
  credentialFields,
  type CredentialsOf,
  defineIntegration,
  defineStep,
} from "@rova/core/plugin";
import { Schema } from "effect";

const resendCredentialFields = credentialFields([
  {
    label: "API Key",
    type: "password",
    placeholder: "re_...",
    configKey: "apiKey",
    envVar: "RESEND_API_KEY",
    helpText: "Get your API key from ",
    helpLink: {
      text: "resend.com/api-keys",
      url: "https://resend.com/api-keys",
    },
  },
  {
    label: "Default Sender",
    type: "text",
    placeholder: "Your Name <noreply@yourdomain.com>",
    configKey: "fromEmail",
    envVar: "RESEND_FROM_EMAIL",
    helpText: "The name and email that will appear as the sender",
  },
]);

/** The credential keys a Resend handler may read, derived from the fields above. */
export type ResendCredentials = CredentialsOf<typeof resendCredentialFields>;

/**
 * The Send Email config, as the step reads it.
 *
 * Every field is a string because that is what a resolved config field is: the
 * editor writes text, and a template variable resolves to text. Which of them a
 * builder has to fill in is stated in `configFields`; what this schema says is
 * what the step may read. `optionalKey` for a field left blank, which reaches a
 * step as an absent key.
 */
export const sendEmailInput = Schema.Struct({
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
 * both a key the handler leaves out and a null it writes where the vendor sent
 * nothing.
 */
export const sendEmailOutput = Schema.Struct({
  id: Schema.String.annotate({ description: "Email ID" }),
  /** Absent on a real send: this is why a test run did not make one. */
  reasonCode: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.annotate({ description: "Why a test run did not send" })
    )
  ),
});

export const resend = defineIntegration({
  type: "resend",
  label: "Resend",
  description: "Send transactional emails",
  credentials: resendCredentialFields,

  test: async () => (await import("#src/resend/test")).testResend,

  actions: {
    "send-email": defineStep({
      label: "Send Email",
      description: "Send an email via Resend",
      category: "Resend",
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
      load: async () =>
        (await import("#src/resend/steps/send-email")).sendEmailHandler,
    }),
  },
});
