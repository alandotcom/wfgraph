import { StepFailure, type StepRunContext } from "@rova/core/plugin";
import { omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import { Effect, Result, Schema } from "effect";
import { describeResendFailure, sendResendEmail } from "#src/resend/client";
import { type ResendCredentials, sendEmailInput } from "#src/resend/index";
import type { JsonObject } from "@rova/shared/types/json";

type ResendTestBehavior = "log_only" | "send_to_test_email";
const TEST_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies: what this step decides is whether and where to send, and every one
 * of those decisions is here.
 */
export const sendEmailHandler = Effect.fn(function* (
  input: typeof sendEmailInput.Type,
  context: StepRunContext<ResendCredentials>
) {
  // The run's own id doubles as the idempotency key: a step Inngest re-runs
  // sends the same key, and Resend replays its first answer rather than sending
  // a second email.
  const idempotencyKey = context.executionId;
  const syntheticIdSuffix = idempotencyKey ?? "no_execution";
  const testBehavior = resolveResendTestBehavior(input.testBehavior);

  // A test run either sends nothing at all or sends to one address the user
  // nominated. Both answers are a success carrying the reason, so the run shows
  // what happened rather than an error the user has to interpret.
  if (context.runMode === "test" && testBehavior === "log_only") {
    return {
      id: `resend:test-log-only:${syntheticIdSuffix}`,
      reasonCode: "test_mode_log_only",
    };
  }

  const testRecipient = input.testEmailTo?.trim() ?? "";
  const routeToTestRecipient =
    context.runMode === "test" && testBehavior === "send_to_test_email";

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

  // The plugin's own credential vocabulary, so a key it never declares is a
  // compile error here rather than an undefined at run time.
  const credentials = yield* context.credentials;
  const apiKey = credentials.RESEND_API_KEY;

  if (!apiKey) {
    return yield* Effect.fail(
      new StepFailure({
        message:
          "RESEND_API_KEY is not configured. Please add it in Project Integrations.",
      })
    );
  }

  const senderEmail = input.emailFrom || credentials.RESEND_FROM_EMAIL;

  if (!senderEmail) {
    return yield* Effect.fail(
      new StepFailure({
        message:
          "No sender is configured. Please add it in the action or in Project Integrations.",
      })
    );
  }

  // A test send goes to the nominated address alone: carrying the real cc and
  // bcc over would mail the people the run was meant to spare.
  const payload = yield* buildEmailPayload(
    input,
    senderEmail,
    routeToTestRecipient
      ? { to: testRecipient }
      : { to: input.emailTo, cc: input.emailCc, bcc: input.emailBcc }
  );

  const sent = yield* sendResendEmail(apiKey, payload, idempotencyKey).pipe(
    Effect.mapError(
      (error) =>
        new StepFailure({
          message: `Failed to send email: ${describeResendFailure(error)}`,
        })
    )
  );

  return { id: sent.id };
});
