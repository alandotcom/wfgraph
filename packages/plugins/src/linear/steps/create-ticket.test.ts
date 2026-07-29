import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { beforeEach, vi } from "vitest";
import { createTicketHandler } from "./create-ticket";

// This step's seam is the Linear SDK, which it constructs itself, so the
// constructor is what the test replaces. What the SDK puts on the wire is
// Linear's business; what this step decides is which team to file under and
// what to say when the SDK throws.
const mocks = vi.hoisted(() => ({
  teams: vi.fn(),
  createIssue: vi.fn(),
}));

vi.mock("@linear/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@linear/sdk")>()),
  LinearClient: class {
    teams = mocks.teams;
    createIssue = mocks.createIssue;
  },
}));

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

// Nothing here reaches the network, because the SDK is stubbed above. The
// transport is provided all the same, since that is what a handler declares it
// needs and the compiler holds the test to it.
const withTransport = Effect.provide(FetchHttpClient.layer);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.teams.mockResolvedValue({ nodes: [{ id: "team_first" }] });
  mocks.createIssue.mockResolvedValue({
    issue: Promise.resolve({
      id: "issue_1",
      url: "https://linear.app/team/issue/ABC-1",
      title: "Bug report",
    }),
  });
});

describe("createTicketHandler", () => {
  it.effect("files under the team the integration names", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({
        ...LINEAR_CREDENTIALS,
        LINEAR_TEAM_ID: "team_named",
      });

      const result = yield* createTicketHandler(
        { ticketTitle: "Bug report", ticketDescription: "It broke" },
        contextFor(credentials)
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
    }).pipe(withTransport)
  );

  it.effect("falls back to the workspace's first team", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      yield* createTicketHandler(
        { ticketTitle: "Bug report" },
        contextFor(credentials)
      );

      expect(mocks.teams).toHaveBeenCalledWith({ first: 1 });
      expect(mocks.createIssue).toHaveBeenCalledWith({
        title: "Bug report",
        description: undefined,
        teamId: "team_first",
      });
    }).pipe(withTransport)
  );

  it.effect("says so when the workspace has no team to file under", () =>
    Effect.gen(function* () {
      mocks.teams.mockResolvedValue({ nodes: [] });
      const { credentials } = credentialsRead();

      const error = yield* failure(
        createTicketHandler(
          { ticketTitle: "Bug report" },
          contextFor(credentials)
        )
      );

      expect(error.message).toBe("No teams found in Linear workspace");
      expect(mocks.createIssue).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("says so when the mutation answered with no issue", () =>
    Effect.gen(function* () {
      mocks.createIssue.mockResolvedValue({ issue: undefined });
      const { credentials } = credentialsRead();

      const error = yield* failure(
        createTicketHandler(
          { ticketTitle: "Bug report" },
          contextFor(credentials)
        )
      );

      expect(error.message).toBe("Failed to create issue");
    }).pipe(withTransport)
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

      const error = yield* failure(
        createTicketHandler(
          { ticketTitle: "Bug report" },
          contextFor(credentials)
        )
      );

      expect(error.message).toBe("Failed to create ticket: Team not found");
    }).pipe(withTransport)
  );

  it.effect("says which credential is missing before reaching Linear", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({});

      const error = yield* failure(
        createTicketHandler(
          { ticketTitle: "Bug report" },
          contextFor(credentials)
        )
      );

      expect(error.message).toBe(
        "LINEAR_API_KEY is not configured. Please add it in Project Integrations."
      );
      expect(mocks.createIssue).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );
});
