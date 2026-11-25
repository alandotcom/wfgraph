import { ExternalTransport } from "@wfgraph/core/plugin";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { recordFetch } from "#src/fetch-test-support";
import {
  createLinearIssue,
  fetchFirstLinearTeamId,
  fetchLinearViewerId,
  listLinearIssues,
} from "#src/linear/client";
import {
  linearIssuePage,
  linearIssues,
  linearResponses,
} from "#src/linear/responses.fixtures";

/**
 * What goes on the wire to Linear's GraphQL endpoint, how its answers decode,
 * and which kind of failure each call ends in. How a failure is worded is
 * `errors.test.ts`'s subject.
 */

const API_KEY = "lin_api_key";

const wire = recordFetch(() => Response.json(linearResponses.viewer));

/** A call that succeeds fails the flip, which is what makes the test say so. */
const failure = Effect.flip;

const withTransport = Effect.provide(ExternalTransport);

/** Answer each request with the next of `responses`, in order. */
function answerInOrder(...responses: Response[]): void {
  wire.answer(() => {
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("Linear was asked for more than the case holds");
    }
    return next;
  });
}

describe("fetchLinearViewerId", () => {
  it.effect("posts the viewer query with the API key as the header", () =>
    Effect.gen(function* () {
      expect(yield* fetchLinearViewerId(API_KEY)).toBe("user_1");

      const request = wire.requests[0];
      expect(request?.url).toBe("https://api.linear.app/graphql");
      expect(request?.method).toBe("POST");
      expect(request?.headers.get("authorization")).toBe(API_KEY);
      expect(request?.headers.get("content-type")).toBe("application/json");
      expect(wire.body(0)).toEqual({
        query: "query Viewer {\n  viewer {\n    id\n  }\n}",
        variables: {},
      });
    }).pipe(withTransport)
  );

  it.effect("fails with Linear's refusal at the status Linear sent", () =>
    Effect.gen(function* () {
      wire.answer(() =>
        Response.json(linearResponses.authenticationError, { status: 400 })
      );

      const error = yield* failure(fetchLinearViewerId(API_KEY));

      expect(error._tag).toBe("ExternalRejected");
      expect(error._tag === "ExternalRejected" && error.status).toBe(400);
    }).pipe(withTransport)
  );
});

describe("fetchFirstLinearTeamId", () => {
  it.effect("asks for one team and answers its id", () =>
    Effect.gen(function* () {
      wire.answer(() => Response.json(linearResponses.firstTeam));

      expect(yield* fetchFirstLinearTeamId(API_KEY)).toBe("team_1");
      expect(wire.body(0)).toEqual({
        query:
          "query FirstTeam {\n  teams(first: 1) {\n    nodes {\n      id\n    }\n  }\n}",
        variables: {},
      });
    }).pipe(withTransport)
  );

  it.effect("answers undefined for a workspace with no team", () =>
    Effect.gen(function* () {
      wire.answer(() => Response.json(linearResponses.noTeams));

      expect(yield* fetchFirstLinearTeamId(API_KEY)).toBeUndefined();
    }).pipe(withTransport)
  );

  // On the live clock, because a read that was rate limited is retried and the
  // wait between attempts is real time. What that schedule does is
  // external-http.test.ts's subject; here it is just time the call takes.
  it.live("retries a read Linear rate limited", () =>
    Effect.gen(function* () {
      answerInOrder(
        Response.json(linearResponses.rateLimited, {
          status: 429,
          headers: { "retry-after": "0" },
        }),
        Response.json(linearResponses.firstTeam)
      );

      expect(yield* fetchFirstLinearTeamId(API_KEY)).toBe("team_1");
      expect(wire.requests).toHaveLength(2);
    }).pipe(withTransport)
  );
});

describe("createLinearIssue", () => {
  it.effect("sends the issue as the mutation's input variable", () =>
    Effect.gen(function* () {
      wire.answer(() => Response.json(linearResponses.issueCreated));

      const issue = yield* createLinearIssue(API_KEY, {
        title: "Bug report",
        description: "It broke",
        teamId: "team_1",
      });

      expect(issue).toEqual(
        linearResponses.issueCreated.data.issueCreate.issue
      );
      expect(wire.requests[0]?.method).toBe("POST");
      expect(wire.requests[0]?.headers.get("authorization")).toBe(API_KEY);
      expect(wire.body(0)).toEqual({
        query:
          "mutation CreateIssue($input: IssueCreateInput!) {\n  issueCreate(input: $input) {\n    success\n    issue {\n      id\n      url\n      title\n    }\n  }\n}",
        variables: {
          input: {
            title: "Bug report",
            description: "It broke",
            teamId: "team_1",
          },
        },
      });
    }).pipe(withTransport)
  );

  it.effect("leaves out a description the caller did not set", () =>
    Effect.gen(function* () {
      wire.answer(() => Response.json(linearResponses.issueCreated));

      yield* createLinearIssue(API_KEY, {
        title: "Bug report",
        description: undefined,
        teamId: "team_1",
      });

      expect(wire.body(0).variables).toEqual({
        input: { title: "Bug report", teamId: "team_1" },
      });
    }).pipe(withTransport)
  );

  it.effect("answers undefined when the payload carries no issue", () =>
    Effect.gen(function* () {
      wire.answer(() => Response.json(linearResponses.issueNotCreated));

      const issue = yield* createLinearIssue(API_KEY, {
        title: "Bug report",
        teamId: "team_1",
      });

      expect(issue).toBeUndefined();
    }).pipe(withTransport)
  );

  // GraphQL reports an operation that failed while it ran beside a null
  // `data`, and Linear can send that with HTTP 200.
  it.effect("fails on an errors array that arrived with HTTP 200", () =>
    Effect.gen(function* () {
      wire.answer(() => Response.json(linearResponses.teamNotFound));

      const error = yield* failure(
        createLinearIssue(API_KEY, { title: "Bug report", teamId: "nope" })
      );

      expect(error._tag).toBe("ExternalRejected");
      expect(error._tag === "ExternalRejected" && error.status).toBe(200);
    }).pipe(withTransport)
  );

  // Linear takes no idempotency key for `issueCreate`, so a repeat could file
  // the issue twice. The 503 is a refusal a read would be retried on.
  it.effect("sends a create once even when Linear is unavailable", () =>
    Effect.gen(function* () {
      wire.answer(() => new Response("unavailable", { status: 503 }));

      const error = yield* failure(
        createLinearIssue(API_KEY, { title: "Bug report", teamId: "team_1" })
      );

      expect(error._tag).toBe("ExternalRejected");
      expect(wire.requests).toHaveLength(1);
    }).pipe(withTransport)
  );

  it.effect("refuses a 2xx that is not the mutation's payload", () =>
    Effect.gen(function* () {
      wire.answer(() => Response.json({ unexpected: true }));

      const error = yield* failure(
        createLinearIssue(API_KEY, { title: "Bug report", teamId: "team_1" })
      );

      expect(error._tag).toBe("ExternalUnreadable");
    }).pipe(withTransport)
  );
});

describe("listLinearIssues", () => {
  it.effect("sends the filter and the page size", () =>
    Effect.gen(function* () {
      wire.answer(() =>
        Response.json(
          linearIssuePage([linearIssues.assigned, linearIssues.unassigned])
        )
      );

      const issues = yield* listLinearIssues(API_KEY, {
        team: { id: { eq: "team_1" } },
      });

      expect(issues).toEqual([linearIssues.assigned, linearIssues.unassigned]);
      expect(wire.body(0)).toEqual({
        query:
          "query ListIssues($filter: IssueFilter, $first: Int, $after: String) {\n  issues(filter: $filter, first: $first, after: $after) {\n    nodes {\n      id\n      title\n      url\n      priority\n      state {\n        name\n      }\n      assignee {\n        id\n      }\n    }\n    pageInfo {\n      hasNextPage\n      endCursor\n    }\n  }\n}",
        variables: { filter: { team: { id: { eq: "team_1" } } }, first: 50 },
      });
    }).pipe(withTransport)
  );

  it.effect("leaves out the filter when there is none", () =>
    Effect.gen(function* () {
      wire.answer(() => Response.json(linearIssuePage([])));

      yield* listLinearIssues(API_KEY, undefined);

      expect(wire.body(0).variables).toEqual({ first: 50 });
    }).pipe(withTransport)
  );

  // Linear's `issues` field is a Relay connection: each page names the cursor
  // the next one starts after.
  it.effect("reads every page, each after the cursor the last one named", () =>
    Effect.gen(function* () {
      answerInOrder(
        Response.json(
          linearIssuePage([linearIssues.assigned], {
            hasNextPage: true,
            endCursor: "cursor_1",
          })
        ),
        Response.json(linearIssuePage([linearIssues.unassigned]))
      );

      const issues = yield* listLinearIssues(API_KEY, {
        team: { id: { eq: "team_1" } },
      });

      expect(wire.bodies().map(({ variables }) => variables)).toEqual([
        { filter: { team: { id: { eq: "team_1" } } }, first: 50 },
        {
          filter: { team: { id: { eq: "team_1" } } },
          first: 50,
          after: "cursor_1",
        },
      ]);
      expect(issues).toEqual([linearIssues.assigned, linearIssues.unassigned]);
    }).pipe(withTransport)
  );
});
