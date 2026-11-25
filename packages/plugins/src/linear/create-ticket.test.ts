import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import { Effect } from "effect";
import { afterEach, beforeEach } from "vitest";
import { linear } from "#src/linear/index";

/**
 * The seam is `fetch`: `runAction` runs the step with the transport that reads
 * the global per call, so a case says what Linear answered to each GraphQL
 * operation and reads back what the step sent. What the client puts on the
 * wire in detail is `client.test.ts`'s subject.
 */

const realFetch = globalThis.fetch;
const LINEAR_CREDENTIALS = { LINEAR_API_KEY: "lin_api_key" };

type SentOperation = { query: string; variables: Record<string, unknown> };

let sent: SentOperation[] = [];
let answers: { firstTeam: Response; createIssue: Response };

/** Answer each GraphQL operation by the name its document declares. */
function stubLinear(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const operation: SentOperation = await new Request(input, init).json();
    sent.push(operation);
    return operation.query.startsWith("query FirstTeam")
      ? answers.firstTeam
      : answers.createIssue;
  }) as typeof fetch;
}

function sentOperation(name: string): SentOperation[] {
  return sent.filter(({ query }) => query.includes(` ${name}`));
}

/** The credentials a run would have fetched. */
function credentialsRead(
  values: Record<string, string | undefined> = LINEAR_CREDENTIALS
) {
  return Effect.sync(() => values);
}

beforeEach(() => {
  sent = [];
  answers = {
    firstTeam: Response.json({
      data: { teams: { nodes: [{ id: "team_first" }] } },
    }),
    createIssue: Response.json({
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: "issue_1",
            url: "https://linear.app/team/issue/ABC-1",
            title: "Bug report",
          },
        },
      },
    }),
  };
  stubLinear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

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
        url: "https://linear.app/team/issue/ABC-1",
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
        input: { title: "Bug report", teamId: "team_first" },
      });
    })
  );

  it.effect("says so when the workspace has no team to file under", () =>
    Effect.gen(function* () {
      answers.firstTeam = Response.json({ data: { teams: { nodes: [] } } });

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
      answers.createIssue = Response.json({
        data: { issueCreate: { success: false, issue: null } },
      });

      const error = actionError(
        yield* runAction(linear(), "create-ticket", {
          input: { ticketTitle: "Bug report" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe("Failed to create issue");
    })
  );

  // The GraphQL error is the specific one, and it is what a user can act on.
  it.effect("reports the GraphQL error Linear answered with", () =>
    Effect.gen(function* () {
      answers.createIssue = Response.json(
        {
          errors: [
            {
              message: "Entity not found: Team",
              extensions: { type: "invalid input", code: "INPUT_ERROR" },
            },
          ],
        },
        { status: 400 }
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
      answers.firstTeam = Response.json(
        {
          errors: [
            {
              message: "Authentication required, not authenticated",
              extensions: {
                type: "authentication error",
                code: "AUTHENTICATION_ERROR",
              },
            },
          ],
        },
        { status: 401 }
      );

      const error = actionError(
        yield* runAction(linear(), "create-ticket", {
          input: { ticketTitle: "Bug report" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe(
        "Failed to create ticket: Authentication required, not authenticated"
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
      expect(sent).toHaveLength(0);
    })
  );
});
