import { listResendDomains, readResendError } from "#src/resend/client";
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

  // Send-only credentials cannot list domains, and the refusal proves they are
  // valid. A manual key answers "restricted_api_key"; an OAuth token answers
  // "invalid_permission", because the grant asks for `emails:send` rather than
  // `full_access`.
  if (
    body?.name === "restricted_api_key" ||
    (isOAuthAccessToken && body?.name === "invalid_permission")
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
