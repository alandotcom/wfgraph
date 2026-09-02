/**
 * The Resend integration: its credentials, its actions, the Events a
 * webhook raises, and the webhook that produces them.
 *
 * The `defineIntegration` call stays in this file. Event schemas and Svix
 * verify live in sibling modules, because they are large enough on their own.
 * The editor gets this plugin's metadata as JSON over `/api/extensions`, so
 * nothing here reaches a browser bundle. The icon is the exception, because a
 * React component cannot be serialized: it stays in `ui.ts`.
 */

import {
  type CredentialFields,
  type CredentialsOf,
  defineIntegration,
  isoTimestampString,
  type JsonObject,
  StepFailure,
} from "@wfgraph/core/plugin";
import { Effect, Result, Schema } from "effect";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  describeResendFailure,
  getResendEmail,
  sendResendEmail,
} from "#src/resend/client";
import { resendEvents } from "#src/resend/events";
import { resendOAuth } from "#src/resend/oauth";
import { resendWebhook } from "#src/resend/webhook";

const resendCredentialFields = {
  RESEND_WEBHOOK_SECRET: {
    label: "Webhook Signing Secret",
    type: "password",
    placeholder: "whsec_...",
    helpText:
      "From the webhook details page in Resend. Optional on a send-only Connection; a POST without it is refused.",
    helpLink: {
      text: "resend.com/webhooks",
      url: "https://resend.com/docs/webhooks/event-types",
    },
  },
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

const TEST_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The three shapes of body a Send Email node can carry. */
const contentModes = ["text", "html", "template"] as const;

/** What a test run does instead of sending to the real recipient. */
const testBehaviors = ["log_only", "send_to_test_email"] as const;

/**
 * The Send Email config, as the step reads it.
 *
 * Every field a builder types into is a string because that is what a resolved
 * config field is: the editor writes text, and a template variable resolves to
 * text. `emailContentMode` and `testBehavior` are the exception, because a
 * `select` writes one of its own option values and nothing else. Which fields a
 * builder has to fill in is stated in `configFields`; what this schema says is
 * what the step may read.
 * `optionalKey` for a field left blank, which reaches a step as an absent key.
 */
const sendEmailInput = Schema.Struct({
  emailTo: Schema.String,
  emailSubject: Schema.String,
  emailFrom: Schema.optionalKey(Schema.String),
  emailBody: Schema.optionalKey(Schema.String),
  emailHtml: Schema.optionalKey(Schema.String),
  emailContentMode: Schema.optionalKey(Schema.Literals(contentModes)),
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
  testBehavior: Schema.optionalKey(Schema.Literals(testBehaviors)),
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
  /**
   * The tags this send carried, in the shape Resend's own webhooks echo them:
   * a key per tag name. The wire body sends the list Resend's send API takes,
   * so the boundary translates and `tags.order_id` then means the same thing
   * here and on a `resend/email.delivered` payload. A repeated tag name folds
   * to one key, which is what the webhook does with it too.
   */
  tags: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: "Email tags",
    })
  ),
});

const findEmailInput = Schema.Struct({
  emailId: Schema.String,
});

const findEmailOutput = Schema.Struct({
  id: Schema.String.annotate({ description: "Email ID" }),
  messageId: Schema.String.annotate({ description: "Provider message ID" }),
  from: Schema.String.annotate({ description: "Sender" }),
  to: Schema.Array(Schema.String).annotate({ description: "Recipients" }),
  cc: Schema.NullOr(
    Schema.Array(Schema.String).annotate({ description: "CC recipients" })
  ),
  bcc: Schema.NullOr(
    Schema.Array(Schema.String).annotate({ description: "BCC recipients" })
  ),
  replyTo: Schema.NullOr(
    Schema.Array(Schema.String).annotate({
      description: "Reply-to addresses",
    })
  ),
  subject: Schema.String.annotate({ description: "Email subject" }),
  html: Schema.NullOr(Schema.String.annotate({ description: "HTML body" })),
  text: Schema.NullOr(
    Schema.String.annotate({ description: "Plain-text body" })
  ),
  createdAt: isoTimestampString("Creation timestamp"),
  lastEvent: Schema.String.annotate({ description: "Latest email event" }),
  scheduledAt: Schema.NullOr(isoTimestampString("Scheduled send timestamp")),
  tags: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: "Email tags",
    })
  ),
});

function isValidTestEmailAddress(value: string): boolean {
  return TEST_EMAIL_PATTERN.test(value);
}

// Tags and template variables reach this step as JSON strings a workflow author
// typed into the node config, so both are parsed at that boundary.
//
// The engine resolves each authored value on its own and re-serialises the list
// (`templateJsonFieldShapes`), so a reference resolving to text with a quotation
// mark in it arrives here escaped rather than as text no parser accepts. Text
// that still does not parse is the author's own, and it fails the step: an email
// that sends without the tags the workflow says it carries leaves every node
// reading `tags.order_id` downstream with nothing, and reports success.
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

/**
 * The value a JSON config box holds, or the failure naming a box whose text does
 * not describe what Resend accepts.
 *
 * Each decode asks for every issue rather than the first, so one failure accounts
 * for the whole string the author typed. The message names the field as the form
 * labels it and the shape it wanted, never the value it rejected.
 */
function readAuthoredJson<T>(
  text: string,
  decode: (input: unknown) => Result.Result<T, Schema.SchemaError>,
  field: { label: string; shape: string }
): Effect.Effect<T, StepFailure> {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () =>
        new StepFailure({ message: `${field.label} is not valid JSON.` }),
    });

    const result = decode(parsed);

    if (Result.isFailure(result)) {
      return yield* new StepFailure({
        message: `${field.label} must be ${field.shape}.`,
      });
    }

    return result.success;
  });
}

function readTags(
  tagsJson: string
): Effect.Effect<typeof emailTagsSchema.Type, StepFailure> {
  return readAuthoredJson(tagsJson, decodeEmailTags, {
    label: "Tags",
    shape: "a list of name and value entries",
  });
}

function readTemplateVariables(
  templateVariables: string
): Effect.Effect<typeof templateVariablesSchema.Type, StepFailure> {
  return readAuthoredJson(templateVariables, decodeTemplateVariables, {
    label: "Template Variables",
    shape: "a JSON object of names to strings or numbers",
  });
}

/**
 * Email tags keyed by name, or nothing where Resend returned no tags.
 *
 * Resend's email API uses a list while its webhooks use a record, so this fold
 * gives both actions and Events the same reference shape. A repeated name keeps
 * the last row, matching what Resend does with one.
 */
function tagsByName(
  tags:
    | ReadonlyArray<{ readonly name: string; readonly value: string }>
    | undefined
): Record<string, string> | undefined {
  return tags?.length
    ? Object.fromEntries(tags.map((tag) => [tag.name, tag.value]))
    : undefined;
}

/**
 * The body fields one content mode contributes.
 *
 * Named as a type so all three modes answer one shape. Left to inference, each
 * mode answers a shape of its own, and a key another mode sets gets the type
 * `undefined`, which a `JsonObject` value rejects.
 */
type EmailContent = {
  text?: string;
  html?: string;
  template?: { id?: string; variables?: typeof templateVariablesSchema.Type };
};

/**
 * The body fields the chosen content mode contributes, or the failure naming the
 * box a builder still has to fill in.
 *
 * A template request carries neither html nor text, which Resend rejects, so each
 * mode adds its own fields and nothing else.
 */
function emailContent(
  input: typeof sendEmailInput.Type
): Effect.Effect<EmailContent, StepFailure> {
  return Effect.gen(function* () {
    switch (input.emailContentMode ?? "text") {
      case "template": {
        if (!input.emailTemplateId) {
          return yield* new StepFailure({
            message: "Content Mode is Template, so a Template must be chosen.",
          });
        }

        const variables = input.emailTemplateVariables
          ? yield* readTemplateVariables(input.emailTemplateVariables)
          : undefined;

        return {
          template: omitUndefined({ id: input.emailTemplateId, variables }),
        };
      }

      case "html": {
        if (!input.emailHtml) {
          return yield* new StepFailure({
            message: "Content Mode is HTML, so HTML Body must be filled in.",
          });
        }

        return omitUndefined({ html: input.emailHtml, text: input.emailBody });
      }

      // Text, the mode `emailContentMode` defaults to. It carries the `default`
      // label because `typescript(consistent-return)` reads a switch over three
      // named cases as a function that can fall out of the end.
      default: {
        if (!input.emailBody) {
          return yield* new StepFailure({
            message: "Content Mode is Text, so Text Body must be filled in.",
          });
        }

        return omitUndefined({ text: input.emailBody, html: input.emailHtml });
      }
    }
  });
}

/** The body Resend is sent. */
const buildEmailPayload = Effect.fn(function* (
  input: typeof sendEmailInput.Type,
  senderEmail: string,
  recipients: { to: string; cc?: string | undefined; bcc?: string | undefined },
  tags: typeof emailTagsSchema.Type | undefined
) {
  const content = yield* emailContent(input);

  // Resend's own field names, which are snake_case on the wire. Every optional
  // field is written out and the blank ones dropped in one pass, because Resend
  // reads an absent field and an empty one differently.
  const payload: JsonObject = omitUndefined({
    from: senderEmail,
    to: recipients.to,
    subject: input.emailSubject,
    cc: recipients.cc,
    bcc: recipients.bcc,
    reply_to: input.emailReplyTo,
    scheduled_at: input.emailScheduledAt,
    topic_id: input.emailTopicId,
    tags,
    ...content,
  });

  return payload;
});

export const resend = defineIntegration({
  type: "resend",
  label: "Resend",
  description: "Send transactional emails",
  credentials: resendCredentialFields,
  oauth: resendOAuth,
  events: resendEvents,
  webhook: resendWebhook,

  test: async () => (await import("#src/resend/test")).testResend,

  // Lazy for the reason `test` is: the template calls stay out of the process
  // until someone opens the node's config panel and asks.
  configOptions: {
    templates: {
      answers: "options",
      load: async () =>
        (await import("#src/resend/config-options")).resendTemplateOptions,
    },
    "template-variables": {
      answers: "fields",
      load: async () =>
        (await import("#src/resend/config-options"))
          .resendTemplateVariableFields,
    },
  },

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
          connectionDefaultKey: "RESEND_FROM_EMAIL",
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
          label: "Template",
          type: "provider-select",
          placeholder: "Choose a template",
          optionsSource: { provider: "templates" },
          showWhen: {
            field: "emailContentMode",
            equals: "template",
          },
        },
        {
          key: "emailTemplateVariables",
          label: "Template Variables",
          type: "provider-fields",
          rows: 6,
          placeholder: '{"FIRST_NAME":"Alice","APPOINTMENT_AT":"2026-03-10"}',
          optionsSource: {
            provider: "template-variables",
            parameters: ["emailTemplateId"],
          },
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
              // A tag name typed here is a key of this step's own `tags` output
              // and of `data.tags` on every outbound `resend/email.*` Event,
              // which is Resend echoing the same tags back. Naming both is what
              // lets the editor offer `tags.name` rather than asking for it to
              // be typed. An inbound `email.received` carries no tags.
              fillsRecords: ["tags", "data.tags"],
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
        const testBehavior = input.testBehavior ?? "log_only";

        // Parsed once, up here, because both the wire body and this step's own
        // answer are built from it. A test run that sends nothing still reports
        // the tags it would have carried, which is how the resolved templates
        // are read back without spending a send.
        const tags = input.emailTags
          ? yield* readTags(input.emailTags)
          : undefined;
        const tagOutput = omitUndefined({ tags: tagsByName(tags) });

        // A test run either sends nothing at all or sends to one address the
        // user nominated. Both answers are a success carrying the reason, so
        // the run shows what happened rather than an error the user has to
        // interpret.
        if (bag.runMode === "test" && testBehavior === "log_only") {
          return {
            ...tagOutput,
            id: `resend:test-log-only:${syntheticIdSuffix}`,
            reasonCode: "test_mode_log_only",
          };
        }

        const testRecipient = input.testEmailTo?.trim() ?? "";
        const routeToTestRecipient =
          bag.runMode === "test" && testBehavior === "send_to_test_email";

        if (routeToTestRecipient && testRecipient.length === 0) {
          return {
            ...tagOutput,
            id: `resend:test-log-fallback:${syntheticIdSuffix}`,
            reasonCode: "test_mode_log_fallback_missing_test_email",
          };
        }

        if (routeToTestRecipient && !isValidTestEmailAddress(testRecipient)) {
          return {
            ...tagOutput,
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
            : { to: input.emailTo, cc: input.emailCc, bcc: input.emailBcc },
          tags
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

        return { ...tagOutput, id: sent.id };
      }),
    },
    "find-email": {
      label: "Find Email",
      description: "Retrieve a sent email by ID from Resend",
      input: findEmailInput,
      output: findEmailOutput,
      configFields: [
        {
          key: "emailId",
          label: "Email ID",
          type: "template-input",
          placeholder: "Email ID or {{NodeName.id}}",
          example: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
          required: true,
        },
      ],
      handler: Effect.fn(function* (bag) {
        const emailId = bag.input.emailId.trim();

        if (!emailId) {
          return yield* new StepFailure({ message: "Email ID is required." });
        }

        const credentials = yield* bag.credentials;
        const apiKey = credentials.RESEND_API_KEY;

        if (!apiKey) {
          return yield* new StepFailure({
            message:
              "RESEND_API_KEY is not configured. Please add it in Project Integrations.",
          });
        }

        return yield* bag.step.run(
          "find-email",
          getResendEmail(apiKey, emailId).pipe(
            Effect.map((email) => ({
              id: email.id,
              messageId: email.message_id,
              from: email.from,
              to: email.to,
              cc: email.cc,
              bcc: email.bcc,
              replyTo: email.reply_to,
              subject: email.subject,
              html: email.html,
              text: email.text,
              createdAt: email.created_at.toISOString(),
              lastEvent: email.last_event,
              scheduledAt: email.scheduled_at?.toISOString() ?? null,
              ...omitUndefined({ tags: tagsByName(email.tags) }),
            })),
            Effect.mapError(
              (error) =>
                new StepFailure({
                  message: `Failed to find email: ${describeResendFailure(error)}`,
                })
            )
          )
        );
      }),
    },
  },
});
