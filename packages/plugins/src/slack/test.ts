import { Schema } from "effect";
import {
  callSlack,
  describeSlackFailure,
  readSlackError,
} from "#src/slack/client";
import { callExternalAsync } from "@rova/core/plugin";
import type { IntegrationTestResult } from "@rova/core/plugin";

// auth.test is Slack's own "is this token any good" call: it takes no arguments
// and answers with the workspace and bot the token belongs to.
const authTestSchema = Schema.Struct({
  team: Schema.optionalKey(Schema.String),
});

export async function testSlack(
  credentials: Record<string, string>
): Promise<IntegrationTestResult> {
  const apiKey = credentials.SLACK_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: "SLACK_API_KEY is required",
    };
  }

  // auth.test reads a token back and changes nothing, so a rate-limited attempt
  // is worth repeating even though Slack spells the call as a POST.
  //
  // A connection test answers the credentials UI over a Promise, so this is
  // where the effect is run and the transport provided. The step reaches Slack
  // through the same client without any of that, because `defineStep` does it.
  const result = await callExternalAsync(
    callSlack(apiKey, "auth.test", authTestSchema, { safeToRepeat: true }),
    (error) => error
  );

  if (result.ok) {
    return { success: true };
  }

  const { failure } = result;

  // A request that never arrived has no HTTP status to report, so the transport
  // error is the whole story.
  if (failure._tag === "ExternalUnreachable") {
    return {
      success: false,
      error: failure.message,
      details: { kind: "unreachable", message: failure.message },
    };
  }

  // Slack's own slug when Slack is what refused, and the bare status when
  // something in front of it did. The two are worded differently because only
  // the first names something a user can act on.
  const slackError =
    failure._tag === "ExternalRejected"
      ? readSlackError(failure.payload)
      : undefined;

  if (slackError === undefined) {
    return {
      success: false,
      error: `API validation failed: HTTP ${failure.status}`,
      details: {
        kind: "http",
        status: failure.status,
        message: describeSlackFailure(failure),
      },
    };
  }

  return {
    success: false,
    error: slackError,
    details: {
      kind: "rejected",
      status: failure.status,
      slackError,
      message: describeSlackFailure(failure),
    },
  };
}
