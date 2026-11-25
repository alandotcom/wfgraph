import {
  describeClerkFailure,
  listClerkUsers,
  readClerkError,
} from "#src/clerk/client";
import type { ClerkCredentials } from "#src/clerk/index";
import { callExternalAsync } from "@wfgraph/core/plugin";
import type { IntegrationTestResult } from "@wfgraph/core/plugin";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

export async function testClerk(
  credentials: ClerkCredentials
): Promise<IntegrationTestResult> {
  const secretKey = credentials.CLERK_SECRET_KEY;

  if (!secretKey) {
    return {
      success: false,
      error: "Secret key is required",
    };
  }

  // Clerk secret keys start with sk_live_ or sk_test_. Checking the prefix
  // costs no request and names a publishable key pasted into the secret field
  // more precisely than the 401 Clerk would answer with.
  if (!(secretKey.startsWith("sk_live_") || secretKey.startsWith("sk_test_"))) {
    return {
      success: false,
      error:
        "Invalid secret key format. Clerk secret keys start with 'sk_live_' or 'sk_test_'",
    };
  }

  // A connection test answers the credentials UI over a Promise, so this is
  // where the effect is run and the transport provided. A step reaches Clerk
  // through the same client without any of that, because `defineStep` does it.
  const result = await callExternalAsync(
    listClerkUsers(secretKey, 1),
    (error) => error
  );

  if (result.ok) {
    return { success: true };
  }

  const { failure } = result;

  // A request that never arrived has no HTTP status to report, so the transport
  // error is the whole story.
  if (failure._tag === "ExternalUnreachable") {
    return {
      success: false,
      error: failure.message,
      details: { message: failure.message },
    };
  }

  const body =
    failure._tag === "ExternalRejected"
      ? readClerkError(failure.payload)
      : undefined;

  return {
    success: false,
    error: describeClerkFailure(failure),
    details: omitUndefined({ status: failure.status, errors: body?.errors }),
  };
}
