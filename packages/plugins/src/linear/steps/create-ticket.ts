import { LinearClient } from "@linear/sdk";
import { StepFailure, type StepRunContext } from "@rova/core/plugin";
import { Effect } from "effect";
import { describeLinearFailure } from "#src/linear/errors";
import { createTicketInput, type LinearCredentials } from "#src/linear/index";

/**
 * Everything the Linear SDK does is a Promise that throws, so every call goes
 * through here: the throw becomes the `StepFailure` the run log shows, worded
 * the way this action words its failures.
 */
function callLinear<A>(
  describe: string,
  call: () => Promise<A>
): Effect.Effect<A, StepFailure> {
  return Effect.tryPromise({
    try: call,
    catch: (error) =>
      new StepFailure({
        message: `${describe}: ${describeLinearFailure(error)}`,
      }),
  });
}

/**
 * The team a ticket goes to when the integration names none: Linear's first,
 * which is the whole workspace for the single-team case this covers.
 */
function firstTeamId(linear: LinearClient): Effect.Effect<string, StepFailure> {
  return Effect.gen(function* () {
    const teams = yield* callLinear("Failed to create ticket", () =>
      linear.teams({ first: 1 })
    );
    const firstTeam = teams.nodes[0];

    return firstTeam
      ? firstTeam.id
      : yield* Effect.fail(
          new StepFailure({ message: "No teams found in Linear workspace" })
        );
  });
}

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies.
 */
export const createTicketHandler = Effect.fn(function* (
  input: typeof createTicketInput.Type,
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
  const teamId = credentials.LINEAR_TEAM_ID || (yield* firstTeamId(linear));

  // Linear answers a mutation with a payload holding a promise for the issue it
  // made, so the issue is two awaits away from the call.
  const issue = yield* callLinear("Failed to create ticket", async () => {
    const created = await linear.createIssue({
      title: input.ticketTitle,
      description: input.ticketDescription,
      teamId,
    });

    return created.issue ? await created.issue : undefined;
  });

  if (!issue) {
    return yield* Effect.fail(
      new StepFailure({ message: "Failed to create issue" })
    );
  }

  return { id: issue.id, url: issue.url, title: issue.title };
});
