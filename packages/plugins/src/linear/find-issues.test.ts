import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import { Effect } from "effect";
import { afterEach, beforeEach } from "vitest";
import { linear } from "#src/linear/index";

/**
 * The seam is `fetch`: `runAction` runs the step with the transport that reads
 * the global per call, so a case says what each page of Linear's `issues`
 * connection held and reads back the variables the step sent for it.
 */

const realFetch = globalThis.fetch;
const LINEAR_CREDENTIALS = { LINEAR_API_KEY: "lin_api_key" };

type SentVariables = Record<string, unknown>;

let sentVariables: SentVariables[] = [];
let answers: Response[] = [];

/** Answer each request with the next response in `answers`. */
function stubLinear(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body: { variables: SentVariables } = await new Request(
      input,
      init
    ).json();
    sentVariables.push(body.variables);
    const answer = answers.shift();
    if (!answer) {
      throw new Error("Linear was asked for more pages than the case holds");
    }
    return answer;
  }) as typeof fetch;
}

/** One page of Linear's `issues` connection. */
function issuePage(
  nodes: readonly Record<string, unknown>[],
  pageInfo = { hasNextPage: false, endCursor: "cursor_last" }
): Response {
  return Response.json({ data: { issues: { nodes, pageInfo } } });
}

/** The credentials a run would have fetched. */
function credentialsRead(
  values: Record<string, string | undefined> = LINEAR_CREDENTIALS
) {
  return Effect.sync(() => values);
}

beforeEach(() => {
  sentVariables = [];
  answers = [
    issuePage([
      {
        id: "issue_1",
        title: "Login broken",
        url: "https://linear.app/team/issue/ABC-1",
        priority: 2,
        state: { name: "In Progress" },
        assignee: { id: "user_1" },
      },
    ]),
  ];
  stubLinear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("linear/find-issues", () => {
  it.effect("flattens the issue with its state and assignee", () =>
    Effect.gen(function* () {
      const result = actionData(
        yield* runAction(linear, "find-issues", {
          input: {},
          credentials: credentialsRead(),
        })
      );

      expect(result).toEqual({
        issues: [
          {
            id: "issue_1",
            title: "Login broken",
            url: "https://linear.app/team/issue/ABC-1",
            state: "In Progress",
            priority: 2,
            assigneeId: "user_1",
          },
        ],
        count: 1,
      });
      // The state and the assignee arrive in the same request as the issue.
      expect(sentVariables).toHaveLength(1);
    })
  );

  // Every blank field would otherwise become a filter matching nothing, and
  // "any" is how the status select spells "do not filter on status".
  it.effect("asks for no filter when nothing was filled in", () =>
    Effect.gen(function* () {
      yield* runAction(linear, "find-issues", {
        input: { linearStatus: "any", linearLabel: "" },
        credentials: credentialsRead(),
      });

      expect(sentVariables[0]).toEqual({ first: 50 });
    })
  );

  it.effect("builds Linear's filter shape from the fields given", () =>
    Effect.gen(function* () {
      yield* runAction(linear, "find-issues", {
        input: {
          linearAssigneeId: "user_1",
          linearTeamId: "team_1",
          linearStatus: "in_progress",
          linearLabel: "bug",
        },
        credentials: credentialsRead(),
      });

      expect(sentVariables[0]?.["filter"]).toEqual({
        assignee: { id: { eq: "user_1" } },
        team: { id: { eq: "team_1" } },
        state: { type: { eq: "started" } },
        labels: { name: { eqIgnoreCase: "bug" } },
      });
    })
  );

  it.effect("reads every page in Linear's issue connection", () =>
    Effect.gen(function* () {
      answers = [
        issuePage(
          [
            {
              id: "issue_1",
              title: "First page",
              url: "https://linear.app/team/issue/ABC-1",
              priority: 1,
              state: { name: "Todo" },
              assignee: null,
            },
          ],
          { hasNextPage: true, endCursor: "cursor_1" }
        ),
        issuePage([
          {
            id: "issue_2",
            title: "Second page",
            url: "https://linear.app/team/issue/ABC-2",
            priority: 2,
            state: { name: "In Progress" },
            assignee: null,
          },
        ]),
      ];

      const result = actionData(
        yield* runAction(linear, "find-issues", {
          input: { linearTeamId: "team_1" },
          credentials: credentialsRead(),
        })
      );

      expect(sentVariables).toEqual([
        { filter: { team: { id: { eq: "team_1" } } }, first: 50 },
        {
          filter: { team: { id: { eq: "team_1" } } },
          first: 50,
          after: "cursor_1",
        },
      ]);
      expect(result.issues.map((issue) => issue.id)).toEqual([
        "issue_1",
        "issue_2",
      ]);
      expect(result.count).toBe(2);
    })
  );

  it.effect("names an issue with no state rather than dropping it", () =>
    Effect.gen(function* () {
      answers = [
        issuePage([
          {
            id: "issue_2",
            title: "No state",
            url: "https://linear.app/team/issue/ABC-2",
            priority: 0,
            state: null,
            assignee: null,
          },
        ]),
      ];

      const result = actionData(
        yield* runAction(linear, "find-issues", {
          input: {},
          credentials: credentialsRead(),
        })
      );

      expect(result.issues[0]).toEqual({
        id: "issue_2",
        title: "No state",
        url: "https://linear.app/team/issue/ABC-2",
        state: "Unknown",
        priority: 0,
        assigneeId: null,
      });
    })
  );

  it.effect("reports the GraphQL error Linear answered with", () =>
    Effect.gen(function* () {
      answers = [
        Response.json(
          {
            errors: [
              {
                message: "Authentication required, not authenticated",
                extensions: {
                  type: "authentication error",
                  code: "AUTHENTICATION_ERROR",
                  userPresentableMessage:
                    "You need to authenticate to access this operation.",
                },
              },
            ],
          },
          { status: 400 }
        ),
      ];

      const error = actionError(
        yield* runAction(linear, "find-issues", {
          input: {},
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe(
        "Failed to find issues: You need to authenticate to access this operation."
      );
    })
  );

  it.effect("says which credential is missing before reaching Linear", () =>
    Effect.gen(function* () {
      const error = actionError(
        yield* runAction(linear, "find-issues", {
          input: {},
          credentials: credentialsRead({}),
        })
      );

      expect(error.message).toBe(
        "LINEAR_API_KEY is not configured. Please add it in Project Integrations."
      );
      expect(sentVariables).toHaveLength(0);
    })
  );
});
