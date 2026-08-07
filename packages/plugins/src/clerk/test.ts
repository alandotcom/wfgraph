import { createClerkBackendClient, getClerkApiErrorMessage } from "./client";
import type { ClerkCredentials } from "#src/clerk/index";
import type { IntegrationTestResult } from "@wfgraph/core/plugin";

export async function testClerk(
  credentials: ClerkCredentials
): Promise<IntegrationTestResult> {
  try {
    const secretKey = credentials.CLERK_SECRET_KEY;

    if (!secretKey) {
      return {
        success: false,
        error: "Secret key is required",
      };
    }

    // Validate format - Clerk secret keys start with sk_live_ or sk_test_
    if (
      !(secretKey.startsWith("sk_live_") || secretKey.startsWith("sk_test_"))
    ) {
      return {
        success: false,
        error:
          "Invalid secret key format. Clerk secret keys start with 'sk_live_' or 'sk_test_'",
      };
    }

    const clerkClient = createClerkBackendClient(secretKey);
    await clerkClient.users.getUserList({ limit: 1 });

    return { success: true };
  } catch (error) {
    const details: Record<string, unknown> = {};

    if (error && typeof error === "object") {
      const clerkError = error as {
        status?: number;
        errors?: unknown[];
        message?: string;
      };
      if (clerkError.status !== undefined) details.status = clerkError.status;
      if (clerkError.errors !== undefined) details.errors = clerkError.errors;
      if (clerkError.message !== undefined)
        details.message = clerkError.message;
    }

    return {
      success: false,
      error: getClerkApiErrorMessage(error),
      details,
    };
  }
}
