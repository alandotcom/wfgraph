/**
 * The Linear integration: its credentials, its actions, and what each action
 * takes and gives back.
 *
 * The handlers are not here, and that is the one thing worth knowing about this
 * file. Linear's SDK is a runtime import of both `steps/` and `errors.ts`, so
 * `load` is what keeps it out of a process that never runs a Linear action: a
 * handler's module is imported the first time its action runs, and this file holds
 * only what the editor needs. The schemas are exported for those modules to type
 * themselves against, which is why they are the only exports beside the
 * integration.
 *
 * Only the server imports this. The editor gets the metadata below as JSON over
 * `/api/extensions`, and the icon stays in `ui.ts`.
 */

import {
  credentialFields,
  type CredentialsOf,
  defineIntegration,
  defineStep,
} from "@rova/core/plugin";
import { Schema } from "effect";

const linearCredentialFields = credentialFields([
  {
    label: "API Key",
    type: "password",
    placeholder: "lin_api_...",
    configKey: "apiKey",
    envVar: "LINEAR_API_KEY",
    helpText: "Get your API key from ",
    helpLink: {
      text: "linear.app",
      url: "https://linear.app/settings/account/security/api-keys/new",
    },
  },
  {
    label: "Team ID (Optional)",
    type: "text",
    placeholder: "Will use first team if not specified",
    configKey: "teamId",
    envVar: "LINEAR_TEAM_ID",
    helpText:
      "The team ID to create issues in. Leave blank to use your first team.",
  },
]);

/** The credential keys a Linear handler may read, derived from the fields above. */
export type LinearCredentials = CredentialsOf<typeof linearCredentialFields>;

/**
 * The Create Ticket config, as the step reads it.
 *
 * `optionalKey` for a field a builder may leave blank: the engine resolves a
 * node's templates into the keys the node holds and drops an empty one, so a
 * blank field reaches a step as an absent key.
 */
export const createTicketInput = Schema.Struct({
  ticketTitle: Schema.String,
  ticketDescription: Schema.optionalKey(Schema.String),
});

export const createTicketOutput = Schema.Struct({
  id: Schema.String.annotate({ description: "Ticket ID" }),
  url: Schema.String.annotate({ description: "Ticket URL" }),
  title: Schema.String.annotate({ description: "Ticket title" }),
});

export const findIssuesInput = Schema.Struct({
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

export const findIssuesOutput = Schema.Struct({
  issues: Schema.Array(linearIssueSchema).annotate({
    description: "Array of issues found",
  }),
  count: Schema.Number.annotate({ description: "Number of issues" }).check(
    Schema.isFinite()
  ),
});

export const linear = defineIntegration({
  type: "linear",
  label: "Linear",
  description: "Create and manage issues in Linear",
  credentials: linearCredentialFields,

  test: async () => (await import("#src/linear/test")).testLinear,

  actions: {
    "create-ticket": defineStep({
      label: "Create Ticket",
      description: "Create an issue in Linear",
      category: "Linear",
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
      load: async () =>
        (await import("#src/linear/steps/create-ticket")).createTicketHandler,
    }),

    "find-issues": defineStep({
      label: "Find Issues",
      description: "Search for issues in Linear",
      category: "Linear",
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
      load: async () =>
        (await import("#src/linear/steps/find-issues")).findIssuesHandler,
    }),
  },
});
