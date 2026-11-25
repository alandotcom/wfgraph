/**
 * Linear's GraphQL response bodies, for the Linear tests to answer with.
 *
 * A success body is the `data` shape Linear's schema gives the fields each
 * document in `client.ts` asks for. An error body follows Linear's error
 * format: an `errors` array whose entries carry `message` and `extensions`.
 */

import type { JsonObject } from "@wfgraph/shared/types/json";

/** One issue as the `ListIssues` document asks for it. */
type LinearIssueNode = {
  id: string;
  title: string;
  url: string;
  priority: number;
  state: { name: string } | null;
  assignee: { id: string } | null;
};

export const linearResponses = {
  viewer: { data: { viewer: { id: "user_1" } } },

  firstTeam: { data: { teams: { nodes: [{ id: "team_1" }] } } },

  /** A workspace with no team in it. */
  noTeams: { data: { teams: { nodes: [] } } },

  issueCreated: {
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
  },

  /** An `issueCreate` payload that carries no issue. */
  issueNotCreated: { data: { issueCreate: { success: false, issue: null } } },

  /** The refusal of a request whose API key Linear does not accept. */
  authenticationError: {
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
  },

  rateLimited: {
    errors: [
      { message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } },
    ],
  },

  /**
   * An operation that failed while it ran, which GraphQL reports beside a null
   * `data` and Linear can send with HTTP 200.
   */
  teamNotFound: {
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
  },

  forbidden: {
    data: null,
    errors: [
      {
        message: "Forbidden",
        extensions: { type: "forbidden", code: "FORBIDDEN" },
      },
    ],
  },
} satisfies Record<string, JsonObject>;

/** Issues as one page of the `issues` connection lists them. */
export const linearIssues = {
  assigned: {
    id: "issue_1",
    title: "Login broken",
    url: "https://linear.app/team/issue/ABC-1/login-broken",
    priority: 2,
    state: { name: "In Progress" },
    assignee: { id: "user_1" },
  },
  unassigned: {
    id: "issue_2",
    title: "Unassigned",
    url: "https://linear.app/team/issue/ABC-2/unassigned",
    priority: 0,
    state: { name: "Todo" },
    assignee: null,
  },
} satisfies Record<string, LinearIssueNode>;

/**
 * One page of the `issues` connection. The default `pageInfo` is the last
 * page.
 */
export function linearIssuePage(
  nodes: readonly LinearIssueNode[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: "cursor_last",
  }
): JsonObject {
  return { data: { issues: { nodes: [...nodes], pageInfo } } };
}
