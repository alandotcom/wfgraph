import type { AcuityCredentials } from "./credentials";
import { createAcuityClient, getAcuityErrorMessage } from "./steps/client";

export async function testAcuity(credentials: Record<string, string>) {
  try {
    const userId = credentials.ACUITY_USER_ID?.trim();
    const apiKey = credentials.ACUITY_API_KEY?.trim();

    if (!(userId && apiKey)) {
      return {
        success: false,
        error: "ACUITY_USER_ID and ACUITY_API_KEY are required",
      };
    }

    const clientResult = createAcuityClient({
      ACUITY_USER_ID: userId,
      ACUITY_API_KEY: apiKey,
    } as AcuityCredentials);

    if ("error" in clientResult) {
      return {
        success: false,
        error: "ACUITY_USER_ID and ACUITY_API_KEY are required",
      };
    }

    await clientResult.client.appointments.types();
    return { success: true };
  } catch (error) {
    const message = getAcuityErrorMessage(
      error,
      error instanceof Error ? error.message : String(error)
    );

    if (message.toLowerCase().includes("unauthorized")) {
      return {
        success: false,
        error:
          "Invalid Acuity credentials. Please check your User ID and API key.",
      };
    }

    return {
      success: false,
      error: message,
    };
  }
}
