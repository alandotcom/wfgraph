import { Acuity, AcuityError } from "@fountain-bio/acuity";
import type { AcuityCredentials } from "@/acuity/credentials";
import { getErrorMessage } from "@/shared/utils";

export function createAcuityClient(
  credentials: AcuityCredentials
): { client: Acuity } | { error: string } {
  const userId = credentials.ACUITY_USER_ID?.trim();
  const apiKey = credentials.ACUITY_API_KEY?.trim();

  if (!(userId && apiKey)) {
    return {
      error:
        "ACUITY_USER_ID and ACUITY_API_KEY are required. Add them in Project Integrations.",
    };
  }

  return {
    client: new Acuity({
      userId,
      apiKey,
    }),
  };
}

export function getAcuityErrorMessage(
  error: unknown,
  fallback: string
): string {
  if (error instanceof AcuityError) {
    return error.message;
  }

  const message = getErrorMessage(error);
  if (message && message !== "Unknown error") {
    return message;
  }

  return fallback;
}
