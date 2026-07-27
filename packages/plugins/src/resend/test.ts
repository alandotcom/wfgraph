import { listResendDomains } from "@/resend/client";

export async function testResend(credentials: Record<string, string>) {
  const apiKey = credentials.RESEND_API_KEY;

  if (!(apiKey && apiKey.startsWith("re_"))) {
    return {
      success: false,
      error: "Invalid API key format. Resend API keys start with 're_'",
    };
  }

  const result = await listResendDomains(apiKey);

  if (result.ok) {
    return { success: true };
  }

  const { failure } = result;

  // A request that never arrived has no HTTP status to report.
  if (failure.kind === "unreachable") {
    return {
      success: false,
      error: failure.message,
      details: { message: failure.message },
    };
  }

  // A send-only key answers "restricted_api_key" on non-send endpoints. That
  // confirms the key is valid; it just cannot list domains, which is fine.
  if (failure.kind === "rejected" && failure.name === "restricted_api_key") {
    return { success: true };
  }

  const details = {
    statusCode: failure.status,
    errorName: failure.kind === "rejected" ? failure.name : undefined,
    errorMessage:
      failure.kind === "rejected" ? failure.message : `HTTP ${failure.status}`,
  };

  if (failure.status === 401 || failure.status === 403) {
    return {
      success: false,
      error: "Invalid API key. Please check your Resend API key.",
      details,
    };
  }

  return {
    success: false,
    error: `API validation failed: HTTP ${failure.status}`,
    details,
  };
}
