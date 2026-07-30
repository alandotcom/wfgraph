import { Acuity, AcuityError } from "@fountain-bio/acuity";
import { getAcuityErrorMessage } from "#src/acuity/client";

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

    // The SDK is built here rather than through the steps' own constructor,
    // which answers an effect: both credentials have already been checked, so
    // there is nothing left for it to fail with.
    const client = new Acuity({ userId, apiKey });

    // Listing appointment types is the cheapest read any valid key can make.
    await client.appointments.types();
    return { success: true };
  } catch (error) {
    const message = getAcuityErrorMessage(
      error,
      error instanceof Error ? error.message : String(error)
    );

    const details: Record<string, unknown> = {
      message: error instanceof Error ? error.message : String(error),
    };

    if (error instanceof AcuityError) {
      details.status = error.status;
      details.code = error.code;
      details.payload = error.payload;
    }

    if (message.toLowerCase().includes("unauthorized")) {
      return {
        success: false,
        error:
          "Invalid Acuity credentials. Please check your User ID and API key.",
        details,
      };
    }

    return {
      success: false,
      error: message,
      details,
    };
  }
}
