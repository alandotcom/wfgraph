/**
 * The Test connection button, for PostHog.
 *
 * The capture endpoint cannot answer this question: ingestion is async, so it
 * takes a bad project key as readily as a good one and answers `{"status": 1}`
 * either way. The flags endpoint validates the key against the same host and
 * refuses a bad one, and writes no event doing it.
 */

import {
  describePostHogFailure,
  evaluateFlags,
  readPostHogError,
  resolvePostHogHost,
} from "#src/posthog/client";
import type { PostHogCredentials } from "#src/posthog/index";
import { callExternalAsync } from "@wfgraph/core/plugin";
import type { IntegrationTestResult } from "@wfgraph/core/plugin";

/** The person the check asks about, who does not have to exist. */
const TEST_DISTINCT_ID = "wfgraph-connection-test";

export async function testPostHog(
  credentials: PostHogCredentials
): Promise<IntegrationTestResult> {
  const projectApiKey = credentials.POSTHOG_PROJECT_API_KEY;

  if (!projectApiKey) {
    return { success: false, error: "POSTHOG_PROJECT_API_KEY is required" };
  }

  // PostHog project keys have a known prefix, so saying that names the problem
  // more precisely than the 401 a personal API key pasted here would earn.
  if (!projectApiKey.startsWith("phc_")) {
    return {
      success: false,
      error:
        "Invalid project API key format. PostHog project API keys start with 'phc_'",
    };
  }

  // A connection test answers the credentials UI over a Promise, so this is
  // where the effect is run and the transport provided. A step reaches PostHog
  // through the same client without any of that, because `defineStep` does it.
  const result = await callExternalAsync(
    evaluateFlags(
      {
        projectApiKey,
        host: resolvePostHogHost(credentials.POSTHOG_HOST),
      },
      TEST_DISTINCT_ID
    ),
    (error) => error
  );

  if (result.ok) {
    return { success: true };
  }

  const { failure } = result;

  // A request that never arrived has no HTTP status to report, so the transport
  // error is the whole story. A mistyped host lands here rather than on a 401.
  if (failure._tag === "ExternalUnreachable") {
    return {
      success: false,
      error: failure.message,
      details: { kind: "unreachable", message: failure.message },
    };
  }

  const body =
    failure._tag === "ExternalRejected"
      ? readPostHogError(failure.payload)
      : undefined;

  return {
    success: false,
    error: `API validation failed: HTTP ${failure.status}`,
    details: {
      kind: failure._tag === "ExternalRejected" ? "rejected" : "http",
      status: failure.status,
      code: body?.code,
      message: describePostHogFailure(failure),
    },
  };
}
