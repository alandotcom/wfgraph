import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import { Effect } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
import * as linearClient from "#src/linear/client";
import { linear } from "#src/linear/index";

/**
 * The seam is `createLinearClient`, stubbed so a case says what filter was
 * asked for and how the answer was flattened. Spying that export (rather than
 * `vi.mock` of `@linear/sdk`) keeps isolate:false from colliding with the
 * other Linear suites that need different client shapes.
 */
const mocks = vi.hoisted(() => ({ issues: vi.fn() }));

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
  });
  vi.spyOn(linearClient, "createLinearClient").mockReturnValue({
    issues: mocks.issues,
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("linear/find-issues", () => {
  it.effect("flattens the issue and the state behind it", () =>
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

      expect(mocks.issues).toHaveBeenCalledWith({ filter: undefined });
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

      expect(mocks.issues).toHaveBeenCalledWith({
        filter: {
          assignee: { id: { eq: "user_1" } },
          team: { id: { eq: "team_1" } },
          state: { name: { eqIgnoreCase: "in_progress" } },
          labels: { name: { eqIgnoreCase: "bug" } },
        },
      });
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
      });

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
        yield* runAction(linear, "find-issues", {
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
        yield* runAction(linear, "find-issues", {
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
