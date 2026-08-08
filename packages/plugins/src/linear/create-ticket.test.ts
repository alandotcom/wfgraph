import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import { Effect } from "effect";
import { beforeEach, vi } from "vitest";
import { createLinear } from "#src/linear/index";

/**
 * The seam is `createClient`, injected when the integration is built so a case
 * says which team was filed under and what the SDK threw.
 */
const mocks = vi.hoisted(() => ({
  teams: vi.fn(),
  createIssue: vi.fn(),
}));

function fakeCreateClient(_apiKey: string) {
  return {
    teams: mocks.teams,
    createIssue: mocks.createIssue,
  } as never;
}

const underTest = createLinear(fakeCreateClient);

const LINEAR_CREDENTIALS = { LINEAR_API_KEY: "lin_api_key" };

/** The credentials a run would have fetched, and how often the step asked. */
function credentialsRead(
  values: Record<string, string | undefined> = LINEAR_CREDENTIALS
) {
  const reads = { count: 0 };

  return {
    reads,
    credentials: Effect.sync(() => {
      reads.count += 1;
      return values;
    }),
  };
}

beforeEach(() => {
  mocks.teams.mockReset();
  mocks.createIssue.mockReset();
  mocks.teams.mockResolvedValue({ nodes: [{ id: "team_first" }] });
  mocks.createIssue.mockResolvedValue({
    issue: Promise.resolve({
      id: "issue_1",
      url: "https://linear.app/team/issue/ABC-1",
      title: "Bug report",
    }),
  });
});

describe("linear/create-ticket", () => {
  it.effect("files under the team the integration names", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({
        ...LINEAR_CREDENTIALS,
        LINEAR_TEAM_ID: "team_named",
      });

      const result = actionData(
        yield* runAction(underTest, "create-ticket", {
          input: { ticketTitle: "Bug report", ticketDescription: "It broke" },
          credentials,
        })
      );

      expect(mocks.teams).toHaveBeenCalledTimes(0);
      expect(mocks.createIssue).toHaveBeenCalledWith({
        title: "Bug report",
        description: "It broke",
        teamId: "team_named",
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
      const { credentials } = credentialsRead();

      yield* runAction(underTest, "create-ticket", {
        input: { ticketTitle: "Bug report" },
        credentials,
      });

      expect(mocks.teams).toHaveBeenCalledWith({ first: 1 });
      expect(mocks.createIssue).toHaveBeenCalledWith({
        title: "Bug report",
        description: undefined,
        teamId: "team_first",
      });
    })
  );

  it.effect("says so when the workspace has no team to file under", () =>
    Effect.gen(function* () {
      mocks.teams.mockResolvedValue({ nodes: [] });
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(underTest, "create-ticket", {
          input: { ticketTitle: "Bug report" },
          credentials,
        })
      );

      expect(error.message).toBe("No teams found in Linear workspace");
      expect(mocks.createIssue).toHaveBeenCalledTimes(0);
    })
  );

  it.effect("says so when the mutation answered with no issue", () =>
    Effect.gen(function* () {
      mocks.createIssue.mockResolvedValue({ issue: undefined });
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(underTest, "create-ticket", {
          input: { ticketTitle: "Bug report" },
          credentials,
        })
      );

      expect(error.message).toBe("Failed to create issue");
    })
  );

  // Linear throws a wrapper carrying the GraphQL errors, and the specific one
  // inside it is what a user can act on.
  it.effect("reports the GraphQL error Linear threw", () =>
    Effect.gen(function* () {
      mocks.createIssue.mockRejectedValue({
        message: "Request failed",
        response: { status: 400, errors: [{ message: "Team not found" }] },
      });
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(underTest, "create-ticket", {
          input: { ticketTitle: "Bug report" },
          credentials,
        })
      );

      expect(error.message).toBe("Failed to create ticket: Team not found");
    })
  );

  it.effect("says which credential is missing before reaching Linear", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({});

      const error = actionError(
        yield* runAction(underTest, "create-ticket", {
          input: { ticketTitle: "Bug report" },
          credentials,
        })
      );

      expect(error.message).toBe(
        "LINEAR_API_KEY is not configured. Please add it in Project Integrations."
      );
      expect(mocks.createIssue).toHaveBeenCalledTimes(0);
    })
  );
});
