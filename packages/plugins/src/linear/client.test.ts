import { ExternalTransport } from "@wfgraph/core/plugin";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach } from "vitest";
import {
  createLinearIssue,
  fetchFirstLinearTeamId,
  fetchLinearViewerId,
  listLinearIssues,
} from "#src/linear/client";
import {
  describeLinearFailure,
  isLinearAuthenticationFailure,
} from "#src/linear/errors";

/**
 * What goes on the wire to Linear's GraphQL endpoint, and how its answers
 * decode. The success bodies are the `data` shapes Linear's schema gives the
 * fields each document asks for. The error bodies follow Linear's error
 * format: an `errors` array whose entries carry `message` and `extensions`.
 */

const realFetch = globalThis.fetch;
const API_KEY = "lin_api_key";
let requests: Request[] = [];

function stubFetch(
  respond: (request: Request) => Response | Promise<Response>
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(respond(request.clone()));
  }) as typeof fetch;
}

/** A call that succeeds fails the flip, which is what makes the test say so. */
const failure = Effect.flip;

const withTransport = Effect.provide(ExternalTransport);

/** Linear's answer to a request whose API key it does not accept. */
const authenticationErrorBody = {
  errors: [
    {
      message: "Authentication required, not authenticated",
      extensions: {
        type: "authentication error",
        code: "AUTHENTICATION_ERROR",
        statusCode: 401,
        userError: true,
        userPresentableMessage:
          "You need to authenticate to access this operation.",
      },
    },
  ],
};

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchLinearViewerId", () => {
  it.effect("posts the viewer query with the API key as the header", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ data: { viewer: { id: "user_1" } } }));

      expect(yield* fetchLinearViewerId(API_KEY)).toBe("user_1");

      const request = requests[0];
      expect(request?.url).toBe("https://api.linear.app/graphql");
      expect(request?.method).toBe("POST");
      expect(request?.headers.get("authorization")).toBe(API_KEY);
      expect(request?.headers.get("content-type")).toBe("application/json");
      expect(yield* readBody()).toEqual({
        query: "query Viewer {\n  viewer {\n    id\n  }\n}",
        variables: {},
      });
    }).pipe(withTransport)
  );

  it.effect("reads Linear's authentication refusal", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(authenticationErrorBody, { status: 400 }));

      const error = yield* failure(fetchLinearViewerId(API_KEY));

      expect(error._tag).toBe("ExternalRejected");
      expect(isLinearAuthenticationFailure(error)).toBe(true);
      expect(describeLinearFailure(error)).toBe(
        "You need to authenticate to access this operation."
      );
    }).pipe(withTransport)
  );
});

describe("fetchFirstLinearTeamId", () => {
  it.effect("asks for one team and answers its id", () =>
    Effect.gen(function* () {
      stubFetch(() =>
        Response.json({ data: { teams: { nodes: [{ id: "team_1" }] } } })
      );

      expect(yield* fetchFirstLinearTeamId(API_KEY)).toBe("team_1");
      expect(yield* readBody()).toEqual({
        query:
          "query FirstTeam {\n  teams(first: 1) {\n    nodes {\n      id\n    }\n  }\n}",
        variables: {},
      });
    }).pipe(withTransport)
  );

  it.effect("answers undefined for a workspace with no team", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ data: { teams: { nodes: [] } } }));

      expect(yield* fetchFirstLinearTeamId(API_KEY)).toBeUndefined();
    }).pipe(withTransport)
  );

  // On the live clock, because a read that was rate limited is retried and the
  // wait between attempts is real time. What that schedule does is
  // external-http.test.ts's subject; here it is just time the call takes.
  it.live("retries a read Linear rate limited", () =>
    Effect.gen(function* () {
      let attempts = 0;
      stubFetch(() => {
        attempts += 1;
        return attempts === 1
          ? Response.json(
              {
                errors: [
                  {
                    message: "Rate limit exceeded",
                    extensions: { code: "RATELIMITED" },
                  },
                ],
              },
              { status: 429, headers: { "retry-after": "0" } }
            )
          : Response.json({ data: { teams: { nodes: [{ id: "team_1" }] } } });
      });

      expect(yield* fetchFirstLinearTeamId(API_KEY)).toBe("team_1");
      expect(requests).toHaveLength(2);
    }).pipe(withTransport)
  );
});

describe("createLinearIssue", () => {
  const createdBody = {
    data: {
      issueCreate: {
        success: true,
        issue: {
          id: "issue_1",
          url: "https://linear.app/team/issue/ABC-1/bug-report",
          title: "Bug report",
        },
      },
    },
  };

  it.effect("sends the issue as the mutation's input variable", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(createdBody));

      const issue = yield* createLinearIssue(API_KEY, {
        title: "Bug report",
        description: "It broke",
        teamId: "team_1",
      });

      expect(issue).toEqual(createdBody.data.issueCreate.issue);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.headers.get("authorization")).toBe(API_KEY);
      expect(yield* readBody()).toEqual({
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
      stubFetch(() => Response.json(createdBody));

      yield* createLinearIssue(API_KEY, {
        title: "Bug report",
        description: undefined,
        teamId: "team_1",
      });

      expect(yield* readBody()).toMatchObject({
        variables: { input: { title: "Bug report", teamId: "team_1" } },
      });
    }).pipe(withTransport)
  );

  it.effect("answers undefined when the payload carries no issue", () =>
    Effect.gen(function* () {
      stubFetch(() =>
        Response.json({
          data: { issueCreate: { success: false, issue: null } },
        })
      );

      const issue = yield* createLinearIssue(API_KEY, {
        title: "Bug report",
        teamId: "team_1",
      });

      expect(issue).toBeUndefined();
    }).pipe(withTransport)
  );

  // GraphQL reports an operation that failed while it ran beside a null
  // `data`, and Linear can send that with HTTP 200.
  it.effect("reads an errors array that arrived with HTTP 200", () =>
    Effect.gen(function* () {
      stubFetch(() =>
        Response.json({
          data: null,
          errors: [
            {
              message: "Entity not found: Team",
              path: ["issueCreate"],
              extensions: {
                type: "invalid input",
                code: "INPUT_ERROR",
                userError: true,
              },
            },
          ],
        })
      );

      const error = yield* failure(
        createLinearIssue(API_KEY, { title: "Bug report", teamId: "nope" })
      );

      expect(error._tag).toBe("ExternalRejected");
      expect(isLinearAuthenticationFailure(error)).toBe(false);
      expect(describeLinearFailure(error)).toBe("Entity not found: Team");
    }).pipe(withTransport)
  );

  // Linear takes no idempotency key for `issueCreate`, so a repeat could file
  // the issue twice. The 503 is a refusal a read would be retried on.
  it.effect("sends a create once even when Linear is unavailable", () =>
    Effect.gen(function* () {
      stubFetch(() => new Response("unavailable", { status: 503 }));

      const error = yield* failure(
        createLinearIssue(API_KEY, { title: "Bug report", teamId: "team_1" })
      );

      expect(requests).toHaveLength(1);
      expect(describeLinearFailure(error)).toBe("HTTP 503");
    }).pipe(withTransport)
  );

  it.effect("refuses a 2xx that is not the mutation's payload", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ unexpected: true }));

      const error = yield* failure(
        createLinearIssue(API_KEY, { title: "Bug report", teamId: "team_1" })
      );

      expect(error._tag).toBe("ExternalUnreadable");
      expect(describeLinearFailure(error)).toBe(
        "Linear answered 200 with an unrecognized body"
      );
    }).pipe(withTransport)
  );
});

describe("listLinearIssues", () => {
  const pageBody = {
    data: {
      issues: {
        nodes: [
          {
            id: "issue_1",
            title: "Login broken",
            url: "https://linear.app/team/issue/ABC-1/login-broken",
            priority: 2,
            state: { name: "In Progress" },
            assignee: { id: "user_1" },
          },
          {
            id: "issue_2",
            title: "Unassigned",
            url: "https://linear.app/team/issue/ABC-2/unassigned",
            priority: 0,
            state: { name: "Todo" },
            assignee: null,
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "cursor_2" },
      },
    },
  };

  it.effect("sends the filter, the page size and the cursor", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(pageBody));

      const page = yield* listLinearIssues(API_KEY, {
        filter: { team: { id: { eq: "team_1" } } },
        after: "cursor_1",
      });

      expect(page).toEqual(pageBody.data.issues);
      expect(yield* readBody()).toEqual({
        query:
          "query ListIssues($filter: IssueFilter, $first: Int, $after: String) {\n  issues(filter: $filter, first: $first, after: $after) {\n    nodes {\n      id\n      title\n      url\n      priority\n      state {\n        name\n      }\n      assignee {\n        id\n      }\n    }\n    pageInfo {\n      hasNextPage\n      endCursor\n    }\n  }\n}",
        variables: {
          filter: { team: { id: { eq: "team_1" } } },
          first: 50,
          after: "cursor_1",
        },
      });
    }).pipe(withTransport)
  );

  it.effect("leaves out the filter and the cursor when there are none", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(pageBody));

      yield* listLinearIssues(API_KEY, {});

      expect((yield* readBody()).variables).toEqual({ first: 50 });
    }).pipe(withTransport)
  );
});

/** The JSON body of the first request that was sent. */
function readBody(): Effect.Effect<{
  query: string;
  variables: Record<string, unknown>;
}> {
  return Effect.promise(() => {
    const request = requests[0];
    if (!request) {
      throw new Error("no request was sent");
    }
    return request.clone().json();
  });
}
