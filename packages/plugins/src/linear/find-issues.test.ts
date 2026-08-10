import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import { Effect } from "effect";
import { beforeEach, vi } from "vitest";
import { createLinear } from "#src/linear/index";

/**
 * The seam is `createClient`, injected when the integration is built so a case
 * says what filter was asked for and how the answer was flattened.
 */
const mocks = vi.hoisted(() => ({ issues: vi.fn() }));

function fakeCreateClient(_apiKey: string) {
  return {
    issues: mocks.issues,
  } as never;
}

const underTest = createLinear(fakeCreateClient);

const LINEAR_CREDENTIALS = { LINEAR_API_KEY: "lin_api_key" };

/** The credentials a run would have fetched. */
function credentialsRead(
  values: Record<string, string | undefined> = LINEAR_CREDENTIALS
) {
  return Effect.sync(() => values);
}

beforeEach(() => {
  mocks.issues.mockReset();
  mocks.issues.mockResolvedValue({
    nodes: [
      {
        id: "issue_1",
        title: "Login broken",
        url: "https://linear.app/team/issue/ABC-1",
        state: Promise.resolve({ name: "In Progress" }),
        priority: 2,
        assigneeId: "user_1",
      },
    ],
    pageInfo: { hasNextPage: false },
    fetchNext: vi.fn(),
  });
});

describe("linear/find-issues", () => {
  it.effect("flattens the issue and the state behind it", () =>
    Effect.gen(function* () {
      const result = actionData(
        yield* runAction(underTest, "find-issues", {
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
    })
  );

  // Every blank field would otherwise become a filter matching nothing, and
  // "any" is how the status select spells "do not filter on status".
  it.effect("asks for no filter when nothing was filled in", () =>
    Effect.gen(function* () {
      yield* runAction(underTest, "find-issues", {
        input: { linearStatus: "any", linearLabel: "" },
        credentials: credentialsRead(),
      });

      expect(mocks.issues).toHaveBeenCalledWith({ filter: undefined });
    })
  );

  it.effect("builds Linear's filter shape from the fields given", () =>
    Effect.gen(function* () {
      yield* runAction(underTest, "find-issues", {
        input: {
          linearAssigneeId: "user_1",
          linearTeamId: "team_1",
          linearStatus: "in_progress",
          linearLabel: "bug",
        },
        credentials: credentialsRead(),
      });

      expect(mocks.issues).toHaveBeenCalledWith({
        filter: {
          assignee: { id: { eq: "user_1" } },
          team: { id: { eq: "team_1" } },
          state: { type: { eq: "started" } },
          labels: { name: { eqIgnoreCase: "bug" } },
        },
      });
    })
  );

  it.effect("reads every page in Linear's issue connection", () =>
    Effect.gen(function* () {
      const found = {
        nodes: [
          {
            id: "issue_1",
            title: "First page",
            url: "https://linear.app/team/issue/ABC-1",
            state: Promise.resolve({ name: "Todo" }),
            priority: 1,
            assigneeId: null,
          },
        ],
        pageInfo: { hasNextPage: true },
        fetchNext: vi.fn(),
      };
      found.fetchNext.mockImplementation(async () => {
        found.nodes.push({
          id: "issue_2",
          title: "Second page",
          url: "https://linear.app/team/issue/ABC-2",
          state: Promise.resolve({ name: "In Progress" }),
          priority: 2,
          assigneeId: null,
        });
        found.pageInfo.hasNextPage = false;
        return found;
      });
      mocks.issues.mockResolvedValue(found);

      const result = actionData(
        yield* runAction(underTest, "find-issues", {
          input: {},
          credentials: credentialsRead(),
        })
      );

      expect(found.fetchNext).toHaveBeenCalledTimes(1);
      expect(result.issues.map((issue) => issue.id)).toEqual([
        "issue_1",
        "issue_2",
      ]);
      expect(result.count).toBe(2);
    })
  );

  it.effect("names an issue with no state rather than dropping it", () =>
    Effect.gen(function* () {
      mocks.issues.mockResolvedValue({
        nodes: [
          {
            id: "issue_2",
            title: "No state",
            url: "https://linear.app/team/issue/ABC-2",
            state: undefined,
            priority: 0,
            assigneeId: null,
          },
        ],
        pageInfo: { hasNextPage: false },
        fetchNext: vi.fn(),
      });

      const result = actionData(
        yield* runAction(underTest, "find-issues", {
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

  it.effect("reports the GraphQL error Linear threw", () =>
    Effect.gen(function* () {
      mocks.issues.mockRejectedValue({
        message: "Request failed",
        response: {
          status: 401,
          errors: [{ message: "Authentication required" }],
        },
      });

      const error = actionError(
        yield* runAction(underTest, "find-issues", {
          input: {},
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe(
        "Failed to find issues: Authentication required"
      );
    })
  );

  it.effect("says which credential is missing before reaching Linear", () =>
    Effect.gen(function* () {
      const error = actionError(
        yield* runAction(underTest, "find-issues", {
          input: {},
          credentials: credentialsRead({}),
        })
      );

      expect(error.message).toBe(
        "LINEAR_API_KEY is not configured. Please add it in Project Integrations."
      );
      expect(mocks.issues).toHaveBeenCalledTimes(0);
    })
  );
});
