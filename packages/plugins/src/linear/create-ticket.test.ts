import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { Effect } from "effect";
import { type FetchResponder, recordFetch } from "#src/fetch-test-support";
import { linear } from "#src/linear/index";
import { linearResponses } from "#src/linear/responses.fixtures";

/**
 * The seam is `fetch`: `runAction` runs the step with the transport that reads
 * the global per call, so a case says what Linear answered to each GraphQL
 * operation and reads back what the step sent. What the client puts on the
 * wire in detail is `client.test.ts`'s subject, and how a refusal is worded is
 * `errors.test.ts`'s.
 */

const LINEAR_CREDENTIALS = { LINEAR_API_KEY: "lin_api_key" };

/** What Linear answers to each of the two operations the step sends. */
type OperationAnswers = {
  firstTeam?: () => Response;
  createIssue?: () => Response;
};

/**
 * Answer each GraphQL operation by the name its document declares. An
 * operation `answers` leaves out succeeds.
 */
function byOperation(answers: OperationAnswers = {}): FetchResponder {
  return (_request, body) => {
    const query = body?.query;
    const isFirstTeam =
      typeof query === "string" && query.startsWith("query FirstTeam");
    const answer = isFirstTeam
      ? (answers.firstTeam ?? (() => Response.json(linearResponses.firstTeam)))
      : (answers.createIssue ??
        (() => Response.json(linearResponses.issueCreated)));
    return answer();
  };
}

const wire = recordFetch(byOperation());

/** The bodies of the requests that sent the operation `name`. */
function sentOperation(name: string): JsonObject[] {
  return wire
    .bodies()
    .filter(
      ({ query }) => typeof query === "string" && query.includes(` ${name}`)
    );
}

/** The credentials a run would have fetched. */
function credentialsRead(
  values: Record<string, string | undefined> = LINEAR_CREDENTIALS
) {
  return Effect.sync(() => values);
}

describe("linear/create-ticket", () => {
  it.effect("files under the team the integration names", () =>
    Effect.gen(function* () {
      const result = actionData(
        yield* runAction(linear(), "create-ticket", {
          input: { ticketTitle: "Bug report", ticketDescription: "It broke" },
          credentials: credentialsRead({
            ...LINEAR_CREDENTIALS,
            LINEAR_TEAM_ID: "team_named",
          }),
        })
      );

      expect(sentOperation("FirstTeam")).toHaveLength(0);
      expect(sentOperation("CreateIssue")[0]?.variables).toEqual({
        input: {
          title: "Bug report",
          description: "It broke",
          teamId: "team_named",
        },
      });
      expect(result).toEqual({
        id: "issue_1",
        url: "https://linear.app/team/issue/ABC-1/bug-report",
        title: "Bug report",
      });
    })
  );

  it.effect("falls back to the workspace's first team", () =>
    Effect.gen(function* () {
      yield* runAction(linear(), "create-ticket", {
        input: { ticketTitle: "Bug report" },
        credentials: credentialsRead(),
      });

      expect(sentOperation("FirstTeam")).toHaveLength(1);
      expect(sentOperation("CreateIssue")[0]?.variables).toEqual({
        input: { title: "Bug report", teamId: "team_1" },
      });
    })
  );

  it.effect("says so when the workspace has no team to file under", () =>
    Effect.gen(function* () {
      wire.answer(
        byOperation({
          firstTeam: () => Response.json(linearResponses.noTeams),
        })
      );

      const error = actionError(
        yield* runAction(linear(), "create-ticket", {
          input: { ticketTitle: "Bug report" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe("No teams found in Linear workspace");
      expect(sentOperation("CreateIssue")).toHaveLength(0);
    })
  );

  it.effect("says so when the mutation answered with no issue", () =>
    Effect.gen(function* () {
      wire.answer(
        byOperation({
          createIssue: () => Response.json(linearResponses.issueNotCreated),
        })
      );

      const error = actionError(
        yield* runAction(linear(), "create-ticket", {
          input: { ticketTitle: "Bug report" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe("Failed to create issue");
    })
  );

  it.effect("puts its own prefix in front of Linear's refusal", () =>
    Effect.gen(function* () {
      wire.answer(
        byOperation({
          createIssue: () =>
            Response.json(linearResponses.teamNotFound, { status: 400 }),
        })
      );

      const error = actionError(
        yield* runAction(linear(), "create-ticket", {
          input: { ticketTitle: "Bug report" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe(
        "Failed to create ticket: Entity not found: Team"
      );
    })
  );

  it.effect("words a failed team lookup as a failed ticket", () =>
    Effect.gen(function* () {
      wire.answer(
        byOperation({
          firstTeam: () =>
            Response.json(linearResponses.authenticationError, {
              status: 401,
            }),
        })
      );

      const error = actionError(
        yield* runAction(linear(), "create-ticket", {
          input: { ticketTitle: "Bug report" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe(
        "Failed to create ticket: You need to authenticate to access this operation."
      );
      expect(sentOperation("CreateIssue")).toHaveLength(0);
    })
  );

  it.effect("says which credential is missing before reaching Linear", () =>
    Effect.gen(function* () {
      const error = actionError(
        yield* runAction(linear(), "create-ticket", {
          input: { ticketTitle: "Bug report" },
          credentials: credentialsRead({}),
        })
      );

      expect(error.message).toBe(
        "LINEAR_API_KEY is not configured. Please add it in Project Integrations."
      );
      expect(wire.requests).toHaveLength(0);
    })
  );
});
