import {
  fetchCredentials,
  type StepInput,
  withStepLogging,
} from "@rova/core/plugin";
import {
  createClerkBackendClient,
  getClerkApiErrorMessage,
  toClerkApiUser,
} from "@/clerk/client";
import type { ClerkCredentials } from "@/clerk/credentials";
import { type ClerkUserResult, toClerkUserData } from "@/clerk/types";

export type ClerkGetUserCoreInput = {
  userId: string;
};

export type ClerkGetUserInput = StepInput &
  ClerkGetUserCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: ClerkGetUserCoreInput,
  credentials: ClerkCredentials
): Promise<ClerkUserResult> {
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
    const user = await clerkClient.users.getUser(input.userId);
    return { success: true, data: toClerkUserData(toClerkApiUser(user)) };
  } catch (err) {
    return {
      success: false,
      error: { message: `Failed to get user: ${getClerkApiErrorMessage(err)}` },
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function clerkGetUserStep(
  input: ClerkGetUserInput
): Promise<ClerkUserResult> {
  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
