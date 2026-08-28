/**
 * What the Send Email node's template fields are filled with.
 *
 * A Promise at its edge for the reason `test.ts` is one: core calls these over a
 * Promise, so this is where the effect is run and the transport provided.
 *
 * Which Resend refusal means what is `client.ts`'s to say, because the
 * connection test asks the same question of the same account and the two must
 * not drift.
 */

import {
  classifyResendFailure,
  describeResendFailure,
  getResendTemplate,
  listResendTemplates,
} from "#src/resend/client";
import type { ResendCredentials } from "#src/resend/index";
import { callExternalAsync, type ExternalError } from "@wfgraph/core/plugin";
import type {
  ConfigOptionField,
  ConfigOptionsAnswer,
  ConfigOptionsRequest,
} from "@wfgraph/core/plugin";

/** Resend's own maximum, so a template can declare no more inputs than it has. */
const MAX_TEMPLATE_VARIABLES = 50;

const NO_API_KEY: ConfigOptionsAnswer = {
  status: "unavailable",
  reason: "not_permitted",
  message: "This Resend connection has no API key. Reconnect it.",
};

/**
 * What a refusal means for this field.
 *
 * `not_permitted` is the only reason the editor offers as something to act on,
 * so it is spent on the two cases where acting on the connection is the fix.
 */
function describeUnavailable(failure: ExternalError): ConfigOptionsAnswer {
  switch (classifyResendFailure(failure)) {
    case "unreachable": {
      return {
        status: "unavailable",
        reason: "unreachable",
        message: describeResendFailure(failure),
      };
    }
    case "send_only_key":
    case "insufficient_scope": {
      return {
        status: "unavailable",
        reason: "not_permitted",
        message:
          "This Resend connection can only send email. Reconnect it and choose full access to pick a template.",
      };
    }
    case "key_unusable": {
      return {
        status: "unavailable",
        reason: "not_permitted",
        message: `This Resend connection is no longer usable: ${describeResendFailure(failure)}`,
      };
    }
    default: {
      return {
        status: "unavailable",
        reason: "refused",
        message: describeResendFailure(failure),
      };
    }
  }
}

/** Every template the account holds, drafts included and labelled as such. */
export async function resendTemplateOptions(
  credentials: ResendCredentials
): Promise<ConfigOptionsAnswer> {
  const apiKey = credentials.RESEND_API_KEY;
  if (!apiKey) {
    return NO_API_KEY;
  }

  const result = await callExternalAsync(
    listResendTemplates(apiKey),
    (error) => error
  );

  if (!result.ok) {
    return describeUnavailable(result.failure);
  }

  if (result.data.reachedPageLimit) {
    // A picker missing the template someone wants, with no way to type it
    // either, is worse than saying the list is too long to draw.
    return {
      status: "unavailable",
      reason: "refused",
      message:
        "This account holds more Resend templates than this list can load. Enter the template id instead.",
    };
  }

  return {
    status: "options",
    // A draft is shown rather than filtered: a template missing from the list
    // with no explanation is worse than a send that reports Resend's own error.
    // Only a template Resend calls a draft is labelled one, so a response that
    // omits the status says nothing rather than calling everything unfinished.
    options: result.data.templates.map((template) => ({
      value: template.id,
      label:
        template.status === "draft"
          ? `${template.name} (draft)`
          : template.name,
    })),
  };
}

/**
 * One input per variable the chosen template declares.
 *
 * The id is sent as the builder gave it. Resend's retrieve endpoint takes an
 * alias as readily as an id, `encodeURIComponent` is what makes the path safe,
 * and Resend's own "Template not found" is a better sentence than a shape check
 * that would refuse the aliases people actually write.
 */
export async function resendTemplateVariableFields(
  credentials: ResendCredentials,
  request: ConfigOptionsRequest
): Promise<ConfigOptionsAnswer> {
  const apiKey = credentials.RESEND_API_KEY;
  const templateId = request.parameters.emailTemplateId;

  // No template chosen yet is not a refusal, and it is not worth a request.
  if (!templateId) {
    return { status: "fields", fields: [] };
  }

  if (!apiKey) {
    return NO_API_KEY;
  }

  const result = await callExternalAsync(
    getResendTemplate(apiKey, templateId),
    (error) => error
  );

  if (!result.ok) {
    return describeUnavailable(result.failure);
  }

  const variables = result.data.variables ?? [];

  return {
    status: "fields",
    fields: variables
      .slice(0, MAX_TEMPLATE_VARIABLES)
      .map((variable): ConfigOptionField => ({
        key: variable.key,
        // Resend has no display name for a variable, so its key is its label.
        label: variable.key,
        // A variable with no fallback has to be supplied or the send fails,
        // which is the whole of what required means here. An empty string is a
        // fallback, so this asks whether one is present rather than truthy.
        ...(variable.fallback_value == null
          ? { required: true as const }
          : { defaultValue: variable.fallback_value }),
        ...(variable.type === "number" ? { type: "number" as const } : {}),
      })),
  };
}
