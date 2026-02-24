import { omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import { type CreateEmailOptions, Resend } from "resend";
import { fetchCredentials } from "@/backend/lib/credential-fetcher";
import {
  type StepInput,
  withStepLogging,
} from "@/backend/lib/steps/step-handler";
import type { ResendCredentials } from "@/plugins/resend/credentials";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTemplateVariablesRecord(
  value: unknown
): value is Record<string, string | number> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(
    (entry) => typeof entry === "string" || typeof entry === "number"
  );
}

function isTag(value: unknown): value is { name: string; value: string } {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.value === "string"
  );
}

function parseTags(
  tagsJson: string
): Array<{ name: string; value: string }> | undefined {
  try {
    const parsed: unknown = JSON.parse(tagsJson);
    if (Array.isArray(parsed) && parsed.every(isTag)) {
      return parsed;
    }
  } catch (error) {
    console.error("[Resend] Failed to parse tags JSON:", error);
  }

  return;
}

function parseTemplateVariables(
  templateVariables: string | undefined
): Record<string, string | number> | undefined {
  if (!templateVariables) {
    return;
  }

  try {
    const parsed: unknown = JSON.parse(templateVariables);
    if (isTemplateVariablesRecord(parsed)) {
      return parsed;
    }
  } catch (error) {
    console.error("[Resend] Failed to parse template variables JSON:", error);
  }

  return;
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

  try {
    const resend = new Resend(apiKey);
    const contentMode = input.emailContentMode || "text";

    const basePayload = {
      from: senderEmail,
      to: input.emailTo,
      subject: input.emailSubject,
      ...omitBy(
        {
          cc: input.emailCc,
          bcc: input.emailBcc,
          replyTo: input.emailReplyTo,
          scheduledAt: input.emailScheduledAt,
          topicId: input.emailTopicId,
          tags: input.emailTags ? parseTags(input.emailTags) : undefined,
        },
        isNil
      ),
    };

    let payload: CreateEmailOptions;

    if (contentMode === "template") {
      if (!input.emailTemplateId) {
        return {
          success: false,
          error: {
            message: "Template mode requires emailTemplateId.",
          },
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
          error: {
            message: "HTML mode requires emailHtml.",
          },
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
          error: {
            message: "Text mode requires emailBody.",
          },
        };
      }

      payload = {
        ...basePayload,
        text: input.emailBody,
        ...omitBy({ html: input.emailHtml }, isNil),
      };
    }

    const { data, error: resendError } = await resend.emails.send(payload, {
      idempotencyKey: input.idempotencyKey,
    });

    if (resendError) {
      return {
        success: false,
        error: {
          message:
            resendError.message ||
            `HTTP ${resendError.statusCode}: Failed to send email`,
        },
      };
    }

    if (!data?.id) {
      return {
        success: false,
        error: {
          message: "Failed to send email: Missing email id in response",
        },
      };
    }

    return { success: true, data: { id: data.id } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: { message: `Failed to send email: ${errorMessage}` },
    };
  }
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
sendEmailStep.maxRetries = 0;

// Export marker for codegen auto-generation
export const _integrationType = "resend";
