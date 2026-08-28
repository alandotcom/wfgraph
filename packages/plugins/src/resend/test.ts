import {
  classifyResendFailure,
  listResendDomains,
  readResendError,
} from "#src/resend/client";
import type { ResendCredentials } from "#src/resend/index";
import { callExternalAsync } from "@wfgraph/core/plugin";
import type {
  IntegrationTestContext,
  IntegrationTestResult,
} from "@wfgraph/core/plugin";

export async function testResend(
  credentials: ResendCredentials,
  context: IntegrationTestContext
): Promise<IntegrationTestResult> {
  const apiKey = credentials.RESEND_API_KEY;

  // An OAuth grant issues its own opaque token, so the "re_" shape is asked of a
  // key the operator typed alone. Which one this is comes from the caller rather
  // than from the token's own text.
  const isOAuthAccessToken =
    context.oauthCredentialKeys.includes("RESEND_API_KEY");

  if (!(apiKey && (isOAuthAccessToken || apiKey.startsWith("re_")))) {
    return {
      success: false,
      error: "Invalid API key format. Resend API keys start with 're_'",
    };
  }

  // A connection test answers the credentials UI over a Promise, so this is
  // where the effect is run and the transport provided. The step reaches Resend
  // through the same client without any of that, because `defineStep` does it.
  const result = await callExternalAsync(
    listResendDomains(apiKey),
    (error) => error
  );

  if (result.ok) {
    return { success: true };
  }

  const { failure } = result;

  // A request that never arrived has no HTTP status to report.
  if (failure._tag === "ExternalUnreachable") {
    return {
      success: false,
      error: failure.message,
      details: { message: failure.message },
    };
  }

  const body =
    failure._tag === "ExternalRejected"
      ? readResendError(failure.payload)
      : undefined;

  // A send-only credential proves itself by the refusal rather than by the
  // listing, because it cannot list domains at all. Which refusal proves it
  // depends on where the credential came from: a manual key is restricted, and
  // a token is scoped. A grant carrying `full_access` lists the domains and
  // never reaches here, and a key Resend has turned off refuses differently.
  const refusal = classifyResendFailure(failure);
  if (
    refusal === "send_only_key" ||
    (isOAuthAccessToken && refusal === "insufficient_scope")
  ) {
    return { success: true };
  }

  // Resend quotes a status in its own error body, which is the number its
  // documentation attaches to the slug. That one wins when it is there.
  const status = body?.statusCode ?? failure.status;
  const details = {
    statusCode: status,
    errorName: body?.name,
    errorMessage: body?.message ?? `HTTP ${failure.status}`,
  };

  if (status === 401 || status === 403) {
    return {
      success: false,
      error: "Invalid API key. Please check your Resend API key.",
      details,
    };
  }

  return {
    success: false,
    error: `API validation failed: HTTP ${status}`,
    details,
  };
}
