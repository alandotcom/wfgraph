import { listResendDomains, readResendError } from "#src/resend/client";
import { callExternalAsync } from "@rova/core/plugin";
import type { IntegrationTestResult } from "@rova/core/plugin";

export async function testResend(
  credentials: Record<string, string>
): Promise<IntegrationTestResult> {
  const apiKey = credentials.RESEND_API_KEY;

  if (!(apiKey && apiKey.startsWith("re_"))) {
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

  // A send-only key answers "restricted_api_key" on non-send endpoints. That
  // confirms the key is valid; it just cannot list domains, which is fine.
  if (body?.name === "restricted_api_key") {
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
