/**
 * What the Linear actions take and what they give back.
 *
 * These sit beside the plugin's metadata rather than beside its steps because
 * both ends need them and only one end is server code: the action metadata in
 * `index.ts` is what the editor loads into the browser, and it derives the
 * template-autocomplete fields from the output schemas here, while the steps in
 * `steps/` are typed against the same constants.
 */

import { Schema } from "effect";

/**
 * The Create Ticket config, as the step reads it.
 *
 * `optional`, not `optionalKey`: the engine resolves a node's templates into
 * every config key the action declares, so a field the user left blank arrives
 * as a key holding `undefined` rather than as no key at all. Exact-optional
 * semantics would reject the config a real run builds.
 */
export const createTicketInput = Schema.Struct({
  ticketTitle: Schema.String,
  ticketDescription: Schema.optional(Schema.String),
});

export const createTicketOutput = Schema.Struct({
  id: Schema.String.annotate({ description: "Ticket ID" }),
  url: Schema.String.annotate({ description: "Ticket URL" }),
  title: Schema.String.annotate({ description: "Ticket title" }),
});

export const findIssuesInput = Schema.Struct({
  linearAssigneeId: Schema.optional(Schema.String),
  linearTeamId: Schema.optional(Schema.String),
  linearStatus: Schema.optional(Schema.String),
  linearLabel: Schema.optional(Schema.String),
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
  assigneeId: Schema.optional(
    Schema.String.annotate({ description: "Assigned user ID" })
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
