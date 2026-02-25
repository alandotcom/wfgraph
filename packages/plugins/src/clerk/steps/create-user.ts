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
} from "@/clerk/client";
import type { ClerkCredentials } from "@/clerk/credentials";
import { type ClerkUserResult, toClerkUserData } from "@/clerk/types";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadataJson(value: string): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(value);
  return isRecord(parsed) ? parsed : undefined;
}

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
        publicMetadata = parseMetadataJson(input.publicMetadata);
        if (!publicMetadata) {
          return {
            success: false,
            error: { message: "Invalid JSON format for publicMetadata" },
          };
        }
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
        privateMetadata = parseMetadataJson(input.privateMetadata);
        if (!privateMetadata) {
          return {
            success: false,
            error: { message: "Invalid JSON format for privateMetadata" },
          };
        }
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
