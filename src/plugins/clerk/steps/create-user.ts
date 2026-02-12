import { omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import { fetchCredentials } from "@/backend/lib/credential-fetcher";
import {
  type StepInput,
  withStepLogging,
} from "@/backend/lib/steps/step-handler";
import {
  createClerkBackendClient,
  getClerkApiErrorMessage,
  toClerkApiUser,
} from "@/plugins/clerk/client";
import type { ClerkCredentials } from "@/plugins/clerk/credentials";
import { type ClerkUserResult, toClerkUserData } from "@/plugins/clerk/types";

export type ClerkCreateUserCoreInput = {
  emailAddress: string;
  firstName?: string;
  lastName?: string;
  password?: string;
  publicMetadata?: string;
  privateMetadata?: string;
};

export type ClerkCreateUserInput = StepInput &
  ClerkCreateUserCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: ClerkCreateUserCoreInput,
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

  if (!input.emailAddress) {
    return {
      success: false,
      error: { message: "Email address is required." },
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
    const createPayload = omitBy(
      {
        emailAddress: [input.emailAddress],
        firstName: input.firstName,
        lastName: input.lastName,
        password: input.password,
        publicMetadata,
        privateMetadata,
      },
      isNil
    );

    const user = await clerkClient.users.createUser(createPayload);
    return { success: true, data: toClerkUserData(toClerkApiUser(user)) };
  } catch (err) {
    return {
      success: false,
      error: {
        message: `Failed to create user: ${getClerkApiErrorMessage(err)}`,
      },
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function clerkCreateUserStep(
  input: ClerkCreateUserInput
): Promise<ClerkUserResult> {
  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
clerkCreateUserStep.maxRetries = 0;

export const _integrationType = "clerk";
