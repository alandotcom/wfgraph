import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import { Effect } from "effect";
import { recordFetch } from "#src/fetch-test-support";
import { linear } from "#src/linear/index";
import {
  linearIssuePage,
  linearIssues,
  linearResponses,
} from "#src/linear/responses.fixtures";

/**
 * The seam is `fetch`: `runAction` runs the step with the transport that reads
 * the global per call, so a case says what Linear's `issues` connection held
 * and reads back the variables the step sent. Reading the connection page by
 * page is `client.test.ts`'s subject, and how a refusal is worded is
 * `errors.test.ts`'s.
 */

const LINEAR_CREDENTIALS = { LINEAR_API_KEY: "lin_api_key" };

const wire = recordFetch(() =>
  Response.json(linearIssuePage([linearIssues.assigned]))
);

/** The credentials a run would have fetched. */
function credentialsRead(
  values: Record<string, string | undefined> = LINEAR_CREDENTIALS
) {
  return Effect.sync(() => values);
}

describe("linear/find-issues", () => {
  it.effect("flattens the issue with its state and assignee", () =>
    Effect.gen(function* () {
      const result = actionData(
        yield* runAction(linear(), "find-issues", {
          input: {},
          credentials: credentialsRead(),
        })
      );

      expect(result).toEqual({
        issues: [
          {
            id: "issue_1",
            title: "Login broken",
            url: "https://linear.app/team/issue/ABC-1/login-broken",
            state: "In Progress",
            priority: 2,
            assigneeId: "user_1",
          },
        ],
        count: 1,
      });
      // The state and the assignee arrive in the same request as the issue.
      expect(wire.requests).toHaveLength(1);
    })
  );

  // Every blank field would otherwise become a filter matching nothing, and
  // "any" is how the status select spells "do not filter on status".
  it.effect("asks for no filter when nothing was filled in", () =>
    Effect.gen(function* () {
      yield* runAction(linear(), "find-issues", {
        input: { linearStatus: "any", linearLabel: "" },
        credentials: credentialsRead(),
      });

      expect(wire.body(0).variables).toEqual({ first: 50 });
    })
  );

  it.effect("builds Linear's filter shape from the fields given", () =>
    Effect.gen(function* () {
      yield* runAction(linear(), "find-issues", {
        input: {
          linearAssigneeId: "user_1",
          linearTeamId: "team_1",
          linearStatus: "in_progress",
          linearLabel: "bug",
        },
        credentials: credentialsRead(),
      });

      expect(wire.body(0).variables).toEqual({
        filter: {
          assignee: { id: { eq: "user_1" } },
          team: { id: { eq: "team_1" } },
          state: { type: { eq: "started" } },
          labels: { name: { eqIgnoreCase: "bug" } },
        },
        first: 50,
      });
    })
  );

  it.effect("names an issue with no state rather than dropping it", () =>
    Effect.gen(function* () {
      wire.answer(() =>
        Response.json(
          linearIssuePage([{ ...linearIssues.unassigned, state: null }])
        )
      );

      const result = actionData(
        yield* runAction(linear(), "find-issues", {
          input: {},
          credentials: credentialsRead(),
        })
      );

      expect(result.issues[0]).toEqual({
        id: "issue_2",
        title: "Unassigned",
        url: "https://linear.app/team/issue/ABC-2/unassigned",
        state: "Unknown",
        priority: 0,
        assigneeId: null,
      });
    })
  );

  it.effect("puts its own prefix in front of Linear's refusal", () =>
    Effect.gen(function* () {
      wire.answer(() =>
        Response.json(linearResponses.authenticationError, { status: 400 })
      );

      const error = actionError(
        yield* runAction(linear(), "find-issues", {
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
        yield* runAction(linear(), "find-issues", {
          input: {},
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
