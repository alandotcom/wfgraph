/**
 * Linear's GraphQL API over fetch.
 *
 * Every operation is a POST to one endpoint carrying a GraphQL document and its
 * variables as JSON, authenticated by the personal API key sent bare in the
 * `Authorization` header. Each document asks for the fields the integration
 * reads and no others. How Linear words a failure is `errors.ts`; the timeout,
 * the retry schedule and the JSON read are `external-http.ts`.
 */

import type { JsonObject } from "@wfgraph/core/plugin";
import { callExternal, type ExternalError } from "@wfgraph/core/plugin";
import { Effect, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { carriesLinearErrors } from "#src/linear/errors";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/**
 * How many issues one page of the `issues` connection asks for. Fifty is the
 * page size Linear documents as its default.
 */
const ISSUE_PAGE_SIZE = 50;

/**
 * One GraphQL request. A query changes nothing, so the reads pass
 * `safeToRepeat` and are retried; Linear spells every operation as a POST, and
 * the method alone would leave them unretried.
 */
function callLinear<S extends Schema.ConstraintDecoder<unknown>>(
  apiKey: string,
  document: string,
  variables: JsonObject,
  schema: S,
  options: { safeToRepeat?: true } = {}
): Effect.Effect<S["Type"], ExternalError, HttpClient.HttpClient> {
  return callExternal({
    system: "Linear",
    url: LINEAR_GRAPHQL_URL,
    method: "POST",
    // Linear's reference sends a personal API key as the whole header value.
    // The `Bearer` prefix is its spelling for an OAuth access token.
    headers: { authorization: apiKey },
    body: { kind: "json", value: { query: document, variables } },
    schema,
    // Linear answers some failures with HTTP 200 and an `errors` array, so a
    // body carrying one is a refusal whatever the status was.
    refusedInBody: carriesLinearErrors,
    safeToRepeat: options.safeToRepeat,
  });
}

/** A GraphQL response whose `data` holds the fields the document asked for. */
function graphqlData<F extends Schema.Struct.Fields>(fields: F) {
  return Schema.Struct({ data: Schema.Struct(fields) });
}

const VIEWER_DOCUMENT = `query Viewer {
  viewer {
    id
  }
}`;

const viewerResponseSchema = graphqlData({
  viewer: Schema.Struct({ id: Schema.String }),
});

/** The id of the user the API key belongs to, which is Linear's cheapest check. */
export function fetchLinearViewerId(
  apiKey: string
): Effect.Effect<string, ExternalError, HttpClient.HttpClient> {
  return callLinear(apiKey, VIEWER_DOCUMENT, {}, viewerResponseSchema, {
    safeToRepeat: true,
  }).pipe(Effect.map(({ data }) => data.viewer.id));
}

const FIRST_TEAM_DOCUMENT = `query FirstTeam {
  teams(first: 1) {
    nodes {
      id
    }
  }
}`;

const firstTeamResponseSchema = graphqlData({
  teams: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ id: Schema.String })),
  }),
});

/**
 * The id of the first team the API key can see, or undefined for a workspace
 * with no team in it.
 */
export function fetchFirstLinearTeamId(
  apiKey: string
): Effect.Effect<string | undefined, ExternalError, HttpClient.HttpClient> {
  return callLinear(apiKey, FIRST_TEAM_DOCUMENT, {}, firstTeamResponseSchema, {
    safeToRepeat: true,
  }).pipe(Effect.map(({ data }) => data.teams.nodes[0]?.id));
}

const CREATE_ISSUE_DOCUMENT = `mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      url
      title
    }
  }
}`;

const createdIssueSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  title: Schema.String,
});

export type LinearCreatedIssue = typeof createdIssueSchema.Type;

const createIssueResponseSchema = graphqlData({
  issueCreate: Schema.Struct({
    success: Schema.Boolean,
    // Linear's schema declares the payload's issue nullable.
    issue: Schema.NullOr(createdIssueSchema),
  }),
});

export type LinearIssueInput = {
  title: string;
  description?: string | undefined;
  teamId: string;
};

/**
 * Create an issue, answering the issue Linear made or undefined when the
 * payload carried none.
 *
 * Creating an issue is a write that Linear cannot deduplicate: `issueCreate`
 * takes no idempotency key. A client-chosen `id` in the input would make a
 * repeat fail as a conflict, which still reports a created issue as a failure.
 * So the request goes out once, with no retry, and a create that timed out on
 * the way back leaves at most one issue in Linear.
 */
export function createLinearIssue(
  apiKey: string,
  input: LinearIssueInput
): Effect.Effect<
  LinearCreatedIssue | undefined,
  ExternalError,
  HttpClient.HttpClient
> {
  return callLinear(
    apiKey,
    CREATE_ISSUE_DOCUMENT,
    { input: omitUndefined(input) },
    createIssueResponseSchema
  ).pipe(Effect.map(({ data }) => data.issueCreate.issue ?? undefined));
}

/**
 * The `IssueFilter` fields the Find Issues action sets. Each one is a
 * comparator object, the shape Linear's filtering reference documents.
 */
export type LinearIssueFilter = {
  assignee?: { id: { eq: string } };
  team?: { id: { eq: string } };
  state?: { type: { eq: string } };
  labels?: { name: { eqIgnoreCase: string } };
};

const LIST_ISSUES_DOCUMENT = `query ListIssues($filter: IssueFilter, $first: Int, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    nodes {
      id
      title
      url
      priority
      state {
        name
      }
      assignee {
        id
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const listedIssueSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
  priority: Schema.Finite,
  // Linear's schema declares an issue's state non-null. The step reports an
  // issue whose state is missing as "Unknown" rather than failing the whole
  // search over one field, so the decode accepts a missing or null state.
  state: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ name: Schema.String }))
  ),
  assignee: Schema.NullOr(Schema.Struct({ id: Schema.String })),
});

export type LinearListedIssue = typeof listedIssueSchema.Type;

const listIssuesResponseSchema = graphqlData({
  issues: Schema.Struct({
    nodes: Schema.Array(listedIssueSchema),
    pageInfo: Schema.Struct({
      hasNextPage: Schema.Boolean,
      endCursor: Schema.NullOr(Schema.String),
    }),
  }),
});

export type LinearIssuePage =
  (typeof listIssuesResponseSchema.Type)["data"]["issues"];

/**
 * One page of the issues matching `filter`, starting after the cursor `after`
 * names, or at the first page when `after` is undefined. Each issue carries its
 * workflow state's name and its assignee's id from the same request.
 */
export function listLinearIssues(
  apiKey: string,
  query: { filter?: LinearIssueFilter | undefined; after?: string | undefined }
): Effect.Effect<LinearIssuePage, ExternalError, HttpClient.HttpClient> {
  return callLinear(
    apiKey,
    LIST_ISSUES_DOCUMENT,
    omitUndefined({
      filter: query.filter,
      first: ISSUE_PAGE_SIZE,
      after: query.after,
    }),
    listIssuesResponseSchema,
    { safeToRepeat: true }
  ).pipe(Effect.map(({ data }) => data.issues));
}
