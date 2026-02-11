import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/steps/step-handler";
import type { ResendCredentials } from "../credentials";

const RESEND_API_URL = "https://api.resend.com";

type ResendEmailResponse = {
  id: string;
};

type ResendErrorResponse = {
  statusCode: number;
  message: string;
  name: string;
};

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
): Record<string, unknown> | undefined {
  if (!templateVariables) {
    return;
  }

  try {
    const parsed = JSON.parse(templateVariables) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
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
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    if (input.idempotencyKey) {
      headers["Idempotency-Key"] = input.idempotencyKey;
    }

    const contentMode = input.emailContentMode || "text";

    const payload: Record<string, unknown> = {
      from: senderEmail,
      to: input.emailTo,
      subject: input.emailSubject,
      ...(input.emailCc && { cc: input.emailCc }),
      ...(input.emailBcc && { bcc: input.emailBcc }),
      ...(input.emailReplyTo && { reply_to: input.emailReplyTo }),
      ...(input.emailScheduledAt && { scheduled_at: input.emailScheduledAt }),
    };

    if (contentMode === "template") {
      if (!input.emailTemplateId) {
        return {
          success: false,
          error: {
            message: "Template mode requires emailTemplateId.",
          },
        };
      }

      payload.template = {
        id: input.emailTemplateId,
        ...(input.emailTemplateVariables && {
          variables: parseTemplateVariables(input.emailTemplateVariables),
        }),
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

      payload.html = input.emailHtml;
      if (input.emailBody) {
        payload.text = input.emailBody;
      }
    } else {
      if (!input.emailBody) {
        return {
          success: false,
          error: {
            message: "Text mode requires emailBody.",
          },
        };
      }

      payload.text = input.emailBody;
      if (input.emailHtml) {
        payload.html = input.emailHtml;
      }
    }

    const response = await fetch(`${RESEND_API_URL}/emails`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as ResendErrorResponse;
      return {
        success: false,
        error: {
          message:
            errorData.message || `HTTP ${response.status}: Failed to send email`,
        },
      };
    }

    const data = (await response.json()) as ResendEmailResponse;
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
  "use step";

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
