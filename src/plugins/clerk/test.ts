import {
  createClerkBackendClient,
  getClerkApiErrorMessage,
} from "./client";

export async function testClerk(credentials: Record<string, string>) {
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
      !secretKey.startsWith("sk_live_") &&
      !secretKey.startsWith("sk_test_")
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
    return {
      success: false,
      error: getClerkApiErrorMessage(error),
    };
  }
}
