import { LinearClient, LinearErrorType } from "@linear/sdk";
import { toLinearError } from "#src/linear/errors";
import type { IntegrationTestResult } from "@rova/core/plugin";

export async function testLinear(
  credentials: Record<string, string>
): Promise<IntegrationTestResult> {
  try {
    const apiKey = credentials.LINEAR_API_KEY;

    if (!apiKey) {
      return {
        success: false,
        error: "LINEAR_API_KEY is required",
      };
    }

    const linearClient = new LinearClient({ apiKey });
    const viewer = await linearClient.viewer;

    if (!viewer?.id) {
      return {
        success: false,
        error: "Failed to verify Linear connection",
      };
    }

    return { success: true };
  } catch (error) {
    const linearError = toLinearError(error);
    const details: Record<string, unknown> = {
      type: linearError.type,
      message: linearError.message,
      errors: linearError.errors,
    };

    if (linearError.type === LinearErrorType.AuthenticationError) {
      return {
        success: false,
        error: "Invalid API key. Please check your Linear API key.",
        details,
      };
    }

    return {
      success: false,
      error:
        linearError.errors?.[0]?.message ||
        linearError.message ||
        (error instanceof Error ? error.message : String(error)),
      details,
    };
  }
}
