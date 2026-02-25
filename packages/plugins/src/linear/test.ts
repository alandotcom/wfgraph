import {
  LinearClient,
  LinearError,
  type LinearErrorRaw,
  LinearErrorType,
  parseLinearError,
} from "@linear/sdk";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLinearErrorRaw(value: unknown): value is LinearErrorRaw {
  if (!isRecord(value)) {
    return false;
  }

  if (value.name !== undefined && typeof value.name !== "string") {
    return false;
  }

  if (value.message !== undefined && typeof value.message !== "string") {
    return false;
  }

  if (value.request !== undefined && !isRecord(value.request)) {
    return false;
  }

  if (value.response !== undefined && !isRecord(value.response)) {
    return false;
  }

  return true;
}

function toLinearError(error: unknown): LinearError {
  if (error instanceof LinearError) {
    return error;
  }

  if (isLinearErrorRaw(error)) {
    return parseLinearError(error);
  }

  if (error instanceof Error) {
    return parseLinearError({ name: error.name, message: error.message });
  }

  if (typeof error === "string") {
    return parseLinearError({ message: error });
  }

  return parseLinearError();
}

export async function testLinear(credentials: Record<string, string>) {
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
