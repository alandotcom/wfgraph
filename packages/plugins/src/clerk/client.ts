import { createClerkClient, type User } from "@clerk/backend";
import { getErrorMessage } from "@wfgraph/core/plugin";
import type { ClerkApiUser } from "./types";

type ClerkApiError = {
  errors?: Array<{ message?: string }>;
  status?: number;
  message?: string;
};

export function createClerkBackendClient(secretKey: string) {
  return createClerkClient({ secretKey });
}

export function toClerkApiUser(user: User): ClerkApiUser {
  return {
    id: user.id,
    first_name: user.firstName,
    last_name: user.lastName,
    email_addresses: user.emailAddresses.map((email) => ({
      id: email.id,
      email_address: email.emailAddress,
    })),
    primary_email_address_id: user.primaryEmailAddressId,
    public_metadata: user.publicMetadata,
    private_metadata: user.privateMetadata,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
  };
}

export function getClerkApiErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const clerkError = error as ClerkApiError;
    const firstError = Array.isArray(clerkError.errors)
      ? clerkError.errors[0]
      : undefined;

    if (
      firstError &&
      typeof firstError.message === "string" &&
      firstError.message.length > 0
    ) {
      return firstError.message;
    }

    if (typeof clerkError.status === "number") {
      return String(clerkError.status);
    }

    if (
      typeof clerkError.message === "string" &&
      clerkError.message.length > 0
    ) {
      return clerkError.message;
    }
  }

  return getErrorMessage(error);
}
