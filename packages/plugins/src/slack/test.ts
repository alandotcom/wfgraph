import { Schema } from "effect";
import { callSlack, describeSlackFailure } from "#src/slack/client";

// auth.test is Slack's own "is this token any good" call: it takes no arguments
// and answers with the workspace and bot the token belongs to.
const authTestSchema = Schema.Struct({
  team: Schema.optionalKey(Schema.String),
});

export async function testSlack(credentials: Record<string, string>) {
  const apiKey = credentials.SLACK_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: "SLACK_API_KEY is required",
    };
  }

  const result = await callSlack(apiKey, "auth.test", authTestSchema);

  if (result.ok) {
    return { success: true };
  }

  const { failure } = result;
  const details = {
    kind: failure.kind,
    status: failure.kind === "unreachable" ? undefined : failure.status,
    slackError: failure.kind === "rejected" ? failure.slackError : undefined,
    message: describeSlackFailure(failure),
  };

  return {
    success: false,
    error:
      failure.kind === "http"
        ? `API validation failed: HTTP ${failure.status}`
        : describeSlackFailure(failure),
    details,
  };
}
