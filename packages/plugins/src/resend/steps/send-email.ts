import { omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import { z } from "zod";
import {
  fetchCredentials,
  type StepInput,
  withStepLogging,
} from "@rova/core/plugin";
import { describeResendFailure, sendResendEmail } from "@/resend/client";
import type { ResendCredentials } from "@/resend/credentials";
import type { JsonObject } from "@rova/shared/types/json";

type SendEmailResult =
  | { success: true; data: { id: string; reasonCode?: string } }
  | { success: false; error: { message: string } };

export type SendEmailCoreInput = {
  emailFrom?: string;
  emailTo: string;
  emailSubject: string;
  emailBody?: string;
  emailHtml?: string;
  emailContentMode?: "text" | "html" | "template";
  emailTemplateId?: string;
  emailTemplateVariables?: string;
  emailCc?: string;
  emailBcc?: string;
  emailReplyTo?: string;
  emailScheduledAt?: string;
  emailTopicId?: string;
  emailTags?: string;
  idempotencyKey?: string;
};

export type SendEmailInput = StepInput &
  SendEmailCoreInput & {
    integrationId?: string;
    testBehavior?: string;
    testEmailTo?: string;
  };

type ResendTestBehavior = "log_only" | "send_to_test_email";
const TEST_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function resolveResendTestBehavior(value: unknown): ResendTestBehavior {
  return value === "send_to_test_email" ? "send_to_test_email" : "log_only";
}

function isValidTestEmailAddress(value: string): boolean {
  return TEST_EMAIL_PATTERN.test(value);
}

// Tags and template variables reach this step as JSON strings a workflow author
// typed into the node config, so both are parsed at that boundary. Text that does
// not describe what Resend accepts is logged and dropped, leaving the email to
// send without it.
const emailTagsSchema = z.array(
  z.object({ name: z.string(), value: z.string() })
);

const templateVariablesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number()])
);

function parseTags(
  tagsJson: string
): z.infer<typeof emailTagsSchema> | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(tagsJson);
  } catch (error) {
    console.error("[Resend] Failed to parse tags JSON:", error);
    return undefined;
  }

  const result = emailTagsSchema.safeParse(parsed);

  if (!result.success) {
    console.error(
      "[Resend] Tags JSON must be a list of { name, value } entries:",
      z.prettifyError(result.error)
    );
    return undefined;
  }

  return result.data;
}

function parseTemplateVariables(
  templateVariables: string | undefined
): z.infer<typeof templateVariablesSchema> | undefined {
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

  const result = templateVariablesSchema.safeParse(parsed);

  if (!result.success) {
    console.error(
      "[Resend] Template variables JSON must map names to strings or numbers:",
      z.prettifyError(result.error)
    );
    return undefined;
  }

  return result.data;
}

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: SendEmailCoreInput,
  credentials: ResendCredentials
): Promise<SendEmailResult> {
  const apiKey = credentials.RESEND_API_KEY;
  const fromEmail = credentials.RESEND_FROM_EMAIL;

  if (!apiKey) {
    return {
      success: false,
      error: {
        message:
          "RESEND_API_KEY is not configured. Please add it in Project Integrations.",
      },
    };
  }

  const senderEmail = input.emailFrom || fromEmail;

  if (!senderEmail) {
    return {
      success: false,
      error: {
        message:
          "No sender is configured. Please add it in the action or in Project Integrations.",
      },
    };
  }

  const contentMode = input.emailContentMode || "text";

  // Resend's own field names, which are snake_case on the wire.
  const basePayload: JsonObject = {
    from: senderEmail,
    to: input.emailTo,
    subject: input.emailSubject,
    ...omitBy(
      {
        cc: input.emailCc,
        bcc: input.emailBcc,
        reply_to: input.emailReplyTo,
        scheduled_at: input.emailScheduledAt,
        topic_id: input.emailTopicId,
        tags: input.emailTags ? parseTags(input.emailTags) : undefined,
      },
      isNil
    ),
  };

  let payload: JsonObject;

  if (contentMode === "template") {
    if (!input.emailTemplateId) {
      return {
        success: false,
        error: { message: "Template mode requires emailTemplateId." },
      };
    }

    payload = {
      ...basePayload,
      template: {
        id: input.emailTemplateId,
        ...omitBy(
          { variables: parseTemplateVariables(input.emailTemplateVariables) },
          isNil
        ),
      },
    };
  } else if (contentMode === "html") {
    if (!input.emailHtml) {
      return {
        success: false,
        error: { message: "HTML mode requires emailHtml." },
      };
    }

    payload = {
      ...basePayload,
      html: input.emailHtml,
      ...omitBy({ text: input.emailBody }, isNil),
    };
  } else {
    if (!input.emailBody) {
      return {
        success: false,
        error: { message: "Text mode requires emailBody." },
      };
    }

    payload = {
      ...basePayload,
      text: input.emailBody,
      ...omitBy({ html: input.emailHtml }, isNil),
    };
  }

  const result = await sendResendEmail(apiKey, payload, input.idempotencyKey);

  if (!result.ok) {
    return {
      success: false,
      error: {
        message: `Failed to send email: ${describeResendFailure(result.failure)}`,
      },
    };
  }

  return { success: true, data: { id: result.data.id } };
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function sendEmailStep(
  input: SendEmailInput
): Promise<SendEmailResult> {
  const runMode = input._context?.runMode ?? "live";
  const idempotencyKey = input._context?.executionId;
  const syntheticIdSuffix = idempotencyKey ?? "no_execution";
  const testBehavior = resolveResendTestBehavior(input.testBehavior);

  if (runMode === "test" && testBehavior === "log_only") {
    return withStepLogging(input, async () => ({
      success: true,
      data: {
        id: `resend:test-log-only:${syntheticIdSuffix}`,
        reasonCode: "test_mode_log_only",
      },
    }));
  }

  const testRecipientRaw =
    typeof input.testEmailTo === "string" ? input.testEmailTo.trim() : "";
  const shouldRouteToTestRecipient =
    runMode === "test" && testBehavior === "send_to_test_email";

  if (shouldRouteToTestRecipient && testRecipientRaw.length === 0) {
    return withStepLogging(input, async () => ({
      success: true,
      data: {
        id: `resend:test-log-fallback:${syntheticIdSuffix}`,
        reasonCode: "test_mode_log_fallback_missing_test_email",
      },
    }));
  }

  if (
    shouldRouteToTestRecipient &&
    !isValidTestEmailAddress(testRecipientRaw)
  ) {
    return withStepLogging(input, async () => ({
      success: true,
      data: {
        id: `resend:test-log-fallback:${syntheticIdSuffix}`,
        reasonCode: "test_mode_log_fallback_invalid_test_email",
      },
    }));
  }

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  const coreInput: SendEmailCoreInput = {
    ...input,
    emailTo: shouldRouteToTestRecipient ? testRecipientRaw : input.emailTo,
    emailCc: shouldRouteToTestRecipient ? undefined : input.emailCc,
    emailBcc: shouldRouteToTestRecipient ? undefined : input.emailBcc,
    idempotencyKey,
  };

  return withStepLogging(input, () => stepHandler(coreInput, credentials));
}
