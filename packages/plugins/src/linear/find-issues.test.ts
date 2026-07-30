import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { beforeEach, vi } from "vitest";
import { findIssuesHandler } from "#src/linear/index";

// This step's seam is the Linear SDK, which it constructs itself, so the
// constructor is what the test replaces. What this step decides is which filter
// to ask for and how to flatten what comes back.
const mocks = vi.hoisted(() => ({ issues: vi.fn() }));

vi.mock("@linear/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@linear/sdk")>()),
  LinearClient: class {
    issues = mocks.issues;
  },
}));

const LINEAR_CREDENTIALS = { LINEAR_API_KEY: "lin_api_key" };

/** The credentials a run would have fetched. */
function credentialsRead(
  values: Record<string, string | undefined> = LINEAR_CREDENTIALS
) {
  return Effect.sync(() => values);
}

function contextFor(
  credentials: Effect.Effect<Record<string, string | undefined>>
) {
  return {
    runMode: "live" as const,
    nodeId: "n1",
    nodeName: "Linear",
    nodeType: "action",
    integrationId: "int_linear",
    credentials,
  };
}

/** A step that succeeds fails the flip, which is what makes the test say so. */
const failure = Effect.flip;

const withTransport = Effect.provide(FetchHttpClient.layer);

beforeEach(() => {
  vi.clearAllMocks();
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
});

describe("findIssuesHandler", () => {
  it.effect("flattens the issue and the state behind it", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead();

      const result = yield* findIssuesHandler({}, contextFor(credentials));

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
    }).pipe(withTransport)
  );

  // Every blank field would otherwise become a filter matching nothing, and
  // "any" is how the status select spells "do not filter on status".
  it.effect("asks for no filter when nothing was filled in", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead();

      yield* findIssuesHandler(
        { linearStatus: "any", linearLabel: "" },
        contextFor(credentials)
      );

      expect(mocks.issues).toHaveBeenCalledWith({ filter: undefined });
    }).pipe(withTransport)
  );

  it.effect("builds Linear's filter shape from the fields given", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead();

      yield* findIssuesHandler(
        {
          linearAssigneeId: "user_1",
          linearTeamId: "team_1",
          linearStatus: "in_progress",
          linearLabel: "bug",
        },
        contextFor(credentials)
      );

      expect(mocks.issues).toHaveBeenCalledWith({
        filter: {
          assignee: { id: { eq: "user_1" } },
          team: { id: { eq: "team_1" } },
          state: { name: { eqIgnoreCase: "in_progress" } },
          labels: { name: { eqIgnoreCase: "bug" } },
        },
      });
    }).pipe(withTransport)
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
      const credentials = credentialsRead();

      const result = yield* findIssuesHandler({}, contextFor(credentials));

      expect(result.issues[0]).toEqual({
        id: "issue_2",
        title: "No state",
        url: "https://linear.app/team/issue/ABC-2",
        state: "Unknown",
        priority: 0,
        assigneeId: null,
      });
    }).pipe(withTransport)
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
      const credentials = credentialsRead();

      const error = yield* failure(
        findIssuesHandler({}, contextFor(credentials))
      );

      expect(error.message).toBe(
        "Failed to find issues: Authentication required"
      );
    }).pipe(withTransport)
  );

  it.effect("says which credential is missing before reaching Linear", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead({});

      const error = yield* failure(
        findIssuesHandler({}, contextFor(credentials))
      );

      expect(error.message).toBe(
        "LINEAR_API_KEY is not configured. Please add it in Project Integrations."
      );
      expect(mocks.issues).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );
});
