import { fetchCredentials } from "@/backend/lib/credential-fetcher";
import {
  type StepInput,
  withStepLogging,
} from "@/backend/lib/steps/step-handler";
import {
  createClerkBackendClient,
  getClerkApiErrorMessage,
} from "@/clerk/client";
import type { ClerkCredentials } from "@/clerk/credentials";

type DeleteUserResult =
  | { success: true; data: { deleted: true } }
  | { success: false; error: { message: string } };

export type ClerkDeleteUserCoreInput = {
  userId: string;
};

export type ClerkDeleteUserInput = StepInput &
  ClerkDeleteUserCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: ClerkDeleteUserCoreInput,
  credentials: ClerkCredentials
): Promise<DeleteUserResult> {
  const secretKey = credentials.CLERK_SECRET_KEY;

  if (!secretKey) {
    return {
      success: false,
      error: {
        message:
          "CLERK_SECRET_KEY is not configured. Please add it in Project Integrations.",
      },
    };
  }

  if (!input.userId) {
    return {
      success: false,
      error: { message: "User ID is required." },
    };
  }

  try {
    const clerkClient = createClerkBackendClient(secretKey);
    await clerkClient.users.deleteUser(input.userId);

    return { success: true, data: { deleted: true } };
  } catch (err) {
    return {
      success: false,
      error: {
        message: `Failed to delete user: ${getClerkApiErrorMessage(err)}`,
      },
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function clerkDeleteUserStep(
  input: ClerkDeleteUserInput
): Promise<DeleteUserResult> {
  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
clerkDeleteUserStep.maxRetries = 0;

export const _integrationType = "clerk";
