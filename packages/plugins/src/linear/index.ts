/**
 * The Linear integration: its credentials, its actions, and what each action
 * takes and gives back.
 *
 * One file, because only the server imports it. The editor gets this plugin's
 * metadata as JSON over `/api/extensions`, so nothing here reaches a browser
 * bundle and the system client below costs the browser nothing. The icon is the
 * exception, because a React component cannot be serialized: it stays in
 * `ui.ts`, which only the browser imports.
 */

import {
  createLinearIssue,
  fetchFirstLinearTeamId,
  type LinearIssueFilter,
  type LinearListedIssue,
  listLinearIssues,
} from "#src/linear/client";
import {
  type CredentialFields,
  type CredentialsOf,
  defineIntegration,
  type ExternalError,
  StepFailure,
} from "@wfgraph/core/plugin";
import { Effect, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { isEmptyObject } from "es-toolkit/predicate";
import { describeLinearFailure } from "#src/linear/errors";
import { testLinear } from "#src/linear/test";

const linearCredentialFields = {
  LINEAR_API_KEY: {
    label: "API Key",
    type: "password",
    placeholder: "lin_api_...",
    helpText: "Get your API key from ",
    helpLink: {
      text: "linear.app",
      url: "https://linear.app/settings/account/security/api-keys/new",
    },
  },
  LINEAR_TEAM_ID: {
    label: "Team ID (Optional)",
    type: "text",
    placeholder: "Will use first team if not specified",
    helpText:
      "The team ID to create issues in. Leave blank to use your first team.",
  },
} satisfies CredentialFields;

export type LinearCredentials = CredentialsOf<typeof linearCredentialFields>;

/**
 * The Create Ticket config, as the step reads it.
 *
 * `optionalKey` for a field a builder may leave blank: the engine resolves a
 * node's templates into the keys the node holds and drops an empty one, so a
 * blank field reaches a step as an absent key.
 */
const createTicketInput = Schema.Struct({
  ticketTitle: Schema.String,
  ticketDescription: Schema.optionalKey(Schema.String),
});

const createTicketOutput = Schema.Struct({
  id: Schema.String.annotate({ title: "Ticket ID" }),
  url: Schema.String.annotate({ title: "Ticket URL" }),
  title: Schema.String.annotate({ title: "Ticket title" }),
});

const linearStatusValues = [
  "any",
  "backlog",
  "todo",
  "in_progress",
  "done",
  "canceled",
] as const;

const findIssuesInput = Schema.Struct({
  linearAssigneeId: Schema.optionalKey(Schema.String),
  linearTeamId: Schema.optionalKey(Schema.String),
  linearStatus: Schema.optionalKey(Schema.Literals(linearStatusValues)),
  linearLabel: Schema.optionalKey(Schema.String),
});

/**
 * Linear state names are workspace-owned and may be renamed. Its state types
 * are the stable vocabulary behind the labels the select presents.
 */
const linearStateType = {
  backlog: "backlog",
  todo: "unstarted",
  in_progress: "started",
  done: "completed",
  canceled: "canceled",
} satisfies Record<Exclude<(typeof linearStatusValues)[number], "any">, string>;

/**
 * One issue as the step reports it, flattened out of Linear's GraphQL objects.
 *
 * The annotations matter twice here: the picker lists `issues[0].title` beside
 * `issues`, so a field inside the list needs to say what it is exactly as much
 * as a field beside it does.
 */
const linearIssueSchema = Schema.Struct({
  id: Schema.String.annotate({ title: "Issue ID" }),
  title: Schema.String.annotate({ title: "Issue title" }),
  url: Schema.String.annotate({ title: "Issue URL" }),
  state: Schema.String.annotate({ title: "Workflow state name" }),
  // A bare `Schema.Number` describes itself as a number or one of the strings
  // "Infinity", "-Infinity" and "NaN", which the field reader cannot use, so
  // the field would drop out of the derived list. The check is what keeps it.
  priority: Schema.Number.annotate({
    description: "Priority, 0 (none) through 4 (low)",
  }).check(Schema.isFinite()),
  assigneeId: Schema.optionalKey(
    Schema.NullOr(Schema.String.annotate({ title: "Assigned user ID" }))
  ),
});

const findIssuesOutput = Schema.Struct({
  issues: Schema.Array(linearIssueSchema).annotate({
    title: "Issues",
    description: "The issues that matched the search.",
  }),
  count: Schema.Number.annotate({ title: "Number of issues" }).check(
    Schema.isFinite()
  ),
});

/**
 * A failed call to Linear as the `StepFailure` the run log shows, worded the
 * way the calling action words its failures.
 */
function linearStepFailure(describe: string) {
  return (error: ExternalError) =>
    new StepFailure({
      message: `${describe}: ${describeLinearFailure(error)}`,
    });
}

/**
 * The team a ticket goes to when the integration names none: Linear's first,
 * which is the whole workspace for the single-team case this covers.
 */
function firstTeamId(
  apiKey: string
): Effect.Effect<string, StepFailure, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const teamId = yield* fetchFirstLinearTeamId(apiKey).pipe(
      Effect.mapError(linearStepFailure("Failed to create ticket"))
    );

    return teamId === undefined
      ? yield* new StepFailure({
          message: "No teams found in Linear workspace",
        })
      : teamId;
  });
}

/**
 * Every issue matching `filter`, read page by page. Linear's `issues` field is
 * a Relay connection, so each page names the cursor the next page starts
 * after, and the loop ends on the page that reports no next page.
 */
function listEveryIssue(
  apiKey: string,
  filter: LinearIssueFilter | undefined
): Effect.Effect<LinearListedIssue[], ExternalError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const issues: LinearListedIssue[] = [];
    let after: string | undefined;

    for (;;) {
      const page = yield* listLinearIssues(apiKey, { filter, after });
      issues.push(...page.nodes);

      const { hasNextPage, endCursor } = page.pageInfo;
      if (!hasNextPage || endCursor === null) {
        return issues;
      }
      after = endCursor;
    }
  });
}

/**
 * The filter Linear's GraphQL API takes, built from the fields the user filled
 * in. A blank field contributes nothing, and "any" is how the status select
 * spells "do not filter on status".
 */
function buildIssueFilter(
  input: typeof findIssuesInput.Type
): LinearIssueFilter | undefined {
  const filter: LinearIssueFilter = {};

  if (input.linearAssigneeId) {
    filter.assignee = { id: { eq: input.linearAssigneeId } };
  }

  if (input.linearTeamId) {
    filter.team = { id: { eq: input.linearTeamId } };
  }

  if (input.linearStatus && input.linearStatus !== "any") {
    filter.state = { type: { eq: linearStateType[input.linearStatus] } };
  }

  if (input.linearLabel) {
    filter.labels = { name: { eqIgnoreCase: input.linearLabel } };
  }

  return isEmptyObject(filter) ? undefined : filter;
}

const linearIntegration = defineIntegration({
  type: "linear",
  label: "Linear",
  description: "Create and manage issues in Linear",
  credentials: linearCredentialFields,

  test: testLinear,

  actions: {
    "create-ticket": {
      label: "Create Ticket",
      description: "Create an issue in Linear",
      sideEffect: true,
      input: createTicketInput,
      output: createTicketOutput,
      configFields: [
        {
          key: "ticketTitle",
          label: "Ticket Title",
          type: "template-input",
          placeholder: "Bug report or {{NodeName.title}}",
          example: "Bug: Login button not working",
          required: true,
        },
        {
          key: "ticketDescription",
          label: "Description",
          type: "template-textarea",
          placeholder:
            "Description. Use {{NodeName.field}} to insert data from previous nodes.",
          rows: 4,
          example: "Users are unable to click the login button on mobile.",
        },
      ],
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const credentials = yield* bag.credentials;
        const apiKey = credentials.LINEAR_API_KEY;

        if (!apiKey) {
          return yield* new StepFailure({
            message:
              "LINEAR_API_KEY is not configured. Please add it in Project Integrations.",
          });
        }

        const teamId =
          credentials.LINEAR_TEAM_ID ||
          (yield* bag.step.run("first-team", firstTeamId(apiKey)));

        const issue = yield* bag.step.run(
          "create-ticket",
          createLinearIssue(apiKey, {
            title: input.ticketTitle,
            description: input.ticketDescription,
            teamId,
          }).pipe(Effect.mapError(linearStepFailure("Failed to create ticket")))
        );

        if (!issue) {
          return yield* new StepFailure({
            message: "Failed to create issue",
          });
        }

        return issue;
      }),
    },

    "find-issues": {
      label: "Find Issues",
      description: "Search for issues in Linear",
      input: findIssuesInput,
      output: findIssuesOutput,
      configFields: [
        {
          key: "linearAssigneeId",
          label: "Assignee (User ID)",
          type: "template-input",
          placeholder: "user-id-123 or {{NodeName.userId}}",
        },
        {
          key: "linearTeamId",
          label: "Team ID (optional)",
          type: "template-input",
          placeholder: "team-id-456 or {{NodeName.teamId}}",
        },
        {
          key: "linearStatus",
          label: "Status (optional)",
          type: "select",
          defaultValue: "any",
          placeholder: "Any status",
          options: [
            { value: "any", label: "Any" },
            { value: "backlog", label: "Backlog" },
            { value: "todo", label: "Todo" },
            { value: "in_progress", label: "In Progress" },
            { value: "done", label: "Done" },
            { value: "canceled", label: "Canceled" },
          ],
        },
        {
          key: "linearLabel",
          label: "Label (optional)",
          type: "template-input",
          placeholder: "bug, feature, etc. or {{NodeName.label}}",
        },
      ],
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const credentials = yield* bag.credentials;
        const apiKey = credentials.LINEAR_API_KEY;

        if (!apiKey) {
          return yield* new StepFailure({
            message:
              "LINEAR_API_KEY is not configured. Please add it in Project Integrations.",
          });
        }

        // Every page is read inside the one step, so the step's memo holds
        // the whole result and a later pass does not read Linear again.
        const issues = yield* bag.step.run(
          "find-issues",
          listEveryIssue(apiKey, buildIssueFilter(input)).pipe(
            Effect.mapBoth({
              onSuccess: (found) =>
                found.map((issue) => ({
                  id: issue.id,
                  title: issue.title,
                  url: issue.url,
                  state: issue.state?.name || "Unknown",
                  priority: issue.priority,
                  assigneeId: issue.assignee?.id ?? null,
                })),
              onFailure: linearStepFailure("Failed to find issues"),
            })
          )
        );

        return { issues, count: issues.length };
      }),
    },
  },
});

/**
 * Returns the Linear integration, for a host to list under
 * `extensions.integrations` in `createWfGraphApp`. The definition is built once
 * when this module loads, so every call returns the same value.
 */
export const linear = () => linearIntegration;
