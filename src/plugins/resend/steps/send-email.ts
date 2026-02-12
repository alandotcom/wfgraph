
import { Resend, type CreateEmailOptions } from "resend";
import { fetchCredentials } from "@/backend/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/backend/lib/steps/step-handler";
import type { ResendCredentials } from "../credentials";

type SendEmailResult =
  | { success: true; data: { id: string } }
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
  idempotencyKey?: string;
};

export type SendEmailInput = StepInput &
  SendEmailCoreInput & {
    integrationId?: string;
  };

function parseTemplateVariables(
  templateVariables: string | undefined
): Record<string, string | number> | undefined {
  if (!templateVariables) {
    return;
  }

  try {
    const parsed = JSON.parse(templateVariables) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string | number>;
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
      ...(input.emailCc && { cc: input.emailCc }),
      ...(input.emailBcc && { bcc: input.emailBcc }),
      ...(input.emailReplyTo && { replyTo: input.emailReplyTo }),
      ...(input.emailScheduledAt && { scheduledAt: input.emailScheduledAt }),
      ...(input.emailTopicId && { topicId: input.emailTopicId }),
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
          ...(input.emailTemplateVariables && {
            variables: parseTemplateVariables(input.emailTemplateVariables),
          }),
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
        ...(input.emailBody && { text: input.emailBody }),
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
        ...(input.emailHtml && { html: input.emailHtml }),
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
        error: { message: "Failed to send email: Missing email id in response" },
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

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  const coreInput: SendEmailCoreInput = {
    ...input,
    idempotencyKey: input._context?.executionId,
  };

  return withStepLogging(input, () => stepHandler(coreInput, credentials));
}
sendEmailStep.maxRetries = 0;

// Export marker for codegen auto-generation
export const _integrationType = "resend";
