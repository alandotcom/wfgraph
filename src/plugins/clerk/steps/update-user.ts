
import { omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import { fetchCredentials } from "@/backend/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/backend/lib/steps/step-handler";
import type { ClerkCredentials } from "../credentials";
import {
  createClerkBackendClient,
  getClerkApiErrorMessage,
  toClerkApiUser,
} from "../client";
import { type ClerkUserResult, toClerkUserData } from "../types";

export type ClerkUpdateUserCoreInput = {
  userId: string;
  firstName?: string;
  lastName?: string;
  publicMetadata?: string;
  privateMetadata?: string;
};

export type ClerkUpdateUserInput = StepInput &
  ClerkUpdateUserCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: ClerkUpdateUserCoreInput,
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
    let publicMetadata: Record<string, unknown> | undefined;
    if (input.publicMetadata) {
      try {
        publicMetadata = JSON.parse(input.publicMetadata) as Record<
          string,
          unknown
        >;
      } catch {
        return {
          success: false,
          error: { message: "Invalid JSON format for publicMetadata" },
        };
      }
    }

    let privateMetadata: Record<string, unknown> | undefined;
    if (input.privateMetadata) {
      try {
        privateMetadata = JSON.parse(input.privateMetadata) as Record<
          string,
          unknown
        >;
      } catch {
        return {
          success: false,
          error: { message: "Invalid JSON format for privateMetadata" },
        };
      }
    }

    const clerkClient = createClerkBackendClient(secretKey);
    const updatePayload = omitBy(
      {
        firstName: input.firstName,
        lastName: input.lastName,
        publicMetadata,
        privateMetadata,
      },
      isNil
    );

    const user = await clerkClient.users.updateUser(input.userId, updatePayload);
    return { success: true, data: toClerkUserData(toClerkApiUser(user)) };
  } catch (err) {
    return {
      success: false,
      error: {
        message: `Failed to update user: ${getClerkApiErrorMessage(err)}`,
      },
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function clerkUpdateUserStep(
  input: ClerkUpdateUserInput
): Promise<ClerkUserResult> {

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
clerkUpdateUserStep.maxRetries = 0;

export const _integrationType = "clerk";
