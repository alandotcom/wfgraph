import { fetchLinearViewerId } from "#src/linear/client";
import {
  describeLinearFailure,
  isLinearAuthenticationFailure,
  readLinearErrors,
} from "#src/linear/errors";
import type { LinearCredentials } from "#src/linear/index";
import { callExternalAsync } from "@wfgraph/core/plugin";
import type { IntegrationTestResult } from "@wfgraph/core/plugin";

export async function testLinear(
  credentials: LinearCredentials
): Promise<IntegrationTestResult> {
  const apiKey = credentials.LINEAR_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: "LINEAR_API_KEY is required",
    };
  }

  // A connection test answers the credentials UI over a Promise, so this is
  // where the effect is run and the transport provided. A step reaches Linear
  // through the same client without any of that, because `defineStep` does it.
  const result = await callExternalAsync(
    fetchLinearViewerId(apiKey),
    (error) => error
  );

  if (result.ok) {
    return { success: true };
  }

  const { failure } = result;

  // A success whose body names no viewer is Linear answering without saying
  // who the key belongs to, which is not a connection worth reporting as
  // working.
  if (failure._tag === "ExternalUnreadable") {
    return {
      success: false,
      error: "Failed to verify Linear connection",
      details: { status: failure.status },
    };
  }

  if (failure._tag === "ExternalUnreachable") {
    return {
      success: false,
      error: failure.message,
      details: { message: failure.message },
    };
  }

  const details = {
    status: failure.status,
    code: readLinearErrors(failure.payload)?.[0]?.extensions?.code,
    message: describeLinearFailure(failure),
  };

  // The authentication refusal is the one that names something a person can
  // act on, so it gets the credentials sentence rather than Linear's wording.
  if (isLinearAuthenticationFailure(failure)) {
    return {
      success: false,
      error: "Invalid API key. Please check your Linear API key.",
      details,
    };
  }

  return { success: false, error: details.message, details };
}
