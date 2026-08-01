/**
 * The Linear integration: its credentials, its actions, and what each action
 * takes and gives back.
 *
 * One file, because only the server imports it. The editor gets this plugin's
 * metadata as JSON over `/api/extensions`, so nothing here reaches a browser
 * bundle and the SDK below costs the browser nothing. The icon is the
 * exception, since a React component cannot be serialized: it stays in `ui.ts`,
 * which only the browser imports.
 */

import { LinearClient, type LinearDocument } from "@linear/sdk";
import {
  type CredentialFields,
  type CredentialsOf,
  defineIntegration,
  StepFailure,
} from "@rova/core/plugin";
import { Effect, Schema } from "effect";
import { describeLinearFailure } from "#src/linear/errors";

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
  id: Schema.String.annotate({ description: "Ticket ID" }),
  url: Schema.String.annotate({ description: "Ticket URL" }),
  title: Schema.String.annotate({ description: "Ticket title" }),
});

const findIssuesInput = Schema.Struct({
  linearAssigneeId: Schema.optionalKey(Schema.String),
  linearTeamId: Schema.optionalKey(Schema.String),
  linearStatus: Schema.optionalKey(Schema.String),
  linearLabel: Schema.optionalKey(Schema.String),
});

/**
 * One issue as the step reports it, flattened out of Linear's GraphQL objects.
 *
 * The annotations matter twice here: the picker lists `issues[0].title` beside
 * `issues`, so a field inside the list needs to say what it is exactly as much
 * as a field beside it does.
 */
const linearIssueSchema = Schema.Struct({
  id: Schema.String.annotate({ description: "Issue ID" }),
  title: Schema.String.annotate({ description: "Issue title" }),
  url: Schema.String.annotate({ description: "Issue URL" }),
  state: Schema.String.annotate({ description: "Workflow state name" }),
  // A bare `Schema.Number` describes itself as a number or one of the strings
  // "Infinity", "-Infinity" and "NaN", which the field reader cannot use, so
  // the field would drop out of the derived list. The check is what keeps it.
  priority: Schema.Number.annotate({
    description: "Priority, 0 (none) through 4 (low)",
  }).check(Schema.isFinite()),
  assigneeId: Schema.optionalKey(
    Schema.NullOr(Schema.String.annotate({ description: "Assigned user ID" }))
  ),
});

const findIssuesOutput = Schema.Struct({
  issues: Schema.Array(linearIssueSchema).annotate({
    description: "Array of issues found",
  }),
  count: Schema.Number.annotate({ description: "Number of issues" }).check(
    Schema.isFinite()
  ),
});

/**
 * Everything the Linear SDK does is a Promise that throws, so every call goes
 * through here: the throw becomes the `StepFailure` the run log shows, worded
 * the way the calling action words its failures.
 */
function callLinear<A>(
  describe: string,
  call: () => Promise<A>
): Effect.Effect<A, StepFailure> {
  return Effect.tryPromise({
    try: call,
    catch: (error) =>
      new StepFailure({
        message: `${describe}: ${describeLinearFailure(error)}`,
      }),
  });
}

/**
 * The team a ticket goes to when the integration names none: Linear's first,
 * which is the whole workspace for the single-team case this covers.
 */
function firstTeamId(client: LinearClient): Effect.Effect<string, StepFailure> {
  return Effect.gen(function* () {
    const teams = yield* callLinear("Failed to create ticket", () =>
      client.teams({ first: 1 })
    );
    const firstTeam = teams.nodes[0];

    return firstTeam
      ? firstTeam.id
      : yield* new StepFailure({
          message: "No teams found in Linear workspace",
        });
  });
}

/**
 * The filter Linear's GraphQL API takes, built from the fields the user filled
 * in. A blank field contributes nothing, and "any" is how the status select
 * spells "do not filter on status".
 */
function buildIssueFilter(
  input: typeof findIssuesInput.Type
): LinearDocument.IssueFilter | undefined {
  const filter: LinearDocument.IssueFilter = {};

  if (input.linearAssigneeId) {
    filter.assignee = { id: { eq: input.linearAssigneeId } };
  }

  if (input.linearTeamId) {
    filter.team = { id: { eq: input.linearTeamId } };
  }

  if (input.linearStatus && input.linearStatus !== "any") {
    filter.state = { name: { eqIgnoreCase: input.linearStatus } };
  }

  if (input.linearLabel) {
    filter.labels = { name: { eqIgnoreCase: input.linearLabel } };
  }

  return Object.keys(filter).length > 0 ? filter : undefined;
}

export const linear = defineIntegration({
  type: "linear",
  label: "Linear",
  description: "Create and manage issues in Linear",
  credentials: linearCredentialFields,

  test: async () => (await import("#src/linear/test")).testLinear,

  actions: {
    "create-ticket": {
      label: "Create Ticket",
      description: "Create an issue in Linear",
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

        const client = new LinearClient({ apiKey });
        const teamId =
          credentials.LINEAR_TEAM_ID || (yield* firstTeamId(client));

        // Linear answers a mutation with a payload holding a promise for the
        // issue it made, so the issue is two awaits away from the call.
        const issue = yield* callLinear("Failed to create ticket", async () => {
          const created = await client.createIssue({
            title: input.ticketTitle,
            description: input.ticketDescription,
            teamId,
          });

          return created.issue ? await created.issue : undefined;
        });

        if (!issue) {
          return yield* new StepFailure({ message: "Failed to create issue" });
        }

        return { id: issue.id, url: issue.url, title: issue.title };
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

        const client = new LinearClient({ apiKey });

        // Everything the Linear SDK does is a Promise that throws, and an
        // issue's state is a second request behind the issue, so the whole read
        // is one call.
        const issues = yield* Effect.tryPromise({
          try: async () => {
            const found = await client.issues({
              filter: buildIssueFilter(input),
            });

            return await Promise.all(
              found.nodes.map(async (issue) => {
                const state = issue.state ? await issue.state : undefined;
                return {
                  id: issue.id,
                  title: issue.title,
                  url: issue.url,
                  state: state?.name || "Unknown",
                  priority: issue.priority,
                  assigneeId: issue.assigneeId ?? null,
                };
              })
            );
          },
          catch: (error) =>
            new StepFailure({
              message: `Failed to find issues: ${describeLinearFailure(error)}`,
            }),
        });

        return { issues, count: issues.length };
      }),
    },
  },
});
