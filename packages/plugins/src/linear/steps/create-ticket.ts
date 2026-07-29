import { LinearClient } from "@linear/sdk";
import {
  defineStep,
  StepFailure,
  type StepRunContext,
} from "@rova/core/plugin";
import { Effect } from "effect";
import type { LinearCredentials } from "#src/linear/credentials";
import { describeLinearFailure } from "#src/linear/errors";
import { createTicketInput, createTicketOutput } from "#src/linear/schemas";

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
  context: StepRunContext
) {
  // The plugin's own credential vocabulary, so a key it never declares is a
  // compile error here rather than an undefined at run time.
  const credentials: LinearCredentials = yield* context.credentials;
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

export const createTicketStep = defineStep({
  id: "linear/create-ticket",
  input: createTicketInput,
  output: createTicketOutput,
  handler: createTicketHandler,
});
