import { LinearClient, type LinearDocument } from "@linear/sdk";
import { StepFailure, type StepRunContext } from "@rova/core/plugin";
import { Effect } from "effect";
import { describeLinearFailure } from "#src/linear/errors";
import type { findIssuesInput, LinearCredentials } from "#src/linear/index";

/**
 * The filter Linear's GraphQL API takes, built from the fields the user filled
 * in. A blank field contributes nothing, and "any" is how the status select
 * spells "do not filter on status".
 */
function buildIssueFilter(
  input: typeof findIssuesInput.Type
): LinearDocument.IssueFilter | undefined {
  const filter: LinearDocument.IssueFilter = {};

  if (input.linearAssigneeId) {
    filter.assignee = { id: { eq: input.linearAssigneeId } };
  }

  if (input.linearTeamId) {
    filter.team = { id: { eq: input.linearTeamId } };
  }

  if (input.linearStatus && input.linearStatus !== "any") {
    filter.state = { name: { eqIgnoreCase: input.linearStatus } };
  }

  if (input.linearLabel) {
    filter.labels = { name: { eqIgnoreCase: input.linearLabel } };
  }

  return Object.keys(filter).length > 0 ? filter : undefined;
}

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies.
 */
export const findIssuesHandler = Effect.fn(function* (
  input: typeof findIssuesInput.Type,
  context: StepRunContext<LinearCredentials>
) {
  const credentials = yield* context.credentials;
  const apiKey = credentials.LINEAR_API_KEY;

  if (!apiKey) {
    return yield* Effect.fail(
      new StepFailure({
        message:
          "LINEAR_API_KEY is not configured. Please add it in Project Integrations.",
      })
    );
  }

  const linear = new LinearClient({ apiKey });

  // Everything the Linear SDK does is a Promise that throws, and an issue's
  // state is a second request behind the issue, so the whole read is one call.
  const issues = yield* Effect.tryPromise({
    try: async () => {
      const found = await linear.issues({ filter: buildIssueFilter(input) });

      return await Promise.all(
        found.nodes.map(async (issue) => {
          const state = issue.state ? await issue.state : undefined;
          return {
            id: issue.id,
            title: issue.title,
            url: issue.url,
            state: state?.name || "Unknown",
            priority: issue.priority,
            assigneeId: issue.assigneeId ?? null,
          };
        })
      );
    },
    catch: (error) =>
      new StepFailure({
        message: `Failed to find issues: ${describeLinearFailure(error)}`,
      }),
  });

  return { issues, count: issues.length };
});
