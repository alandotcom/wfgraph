/**
 * What the Resend actions take and what they give back.
 *
 * These sit beside the plugin's metadata rather than beside its steps because
 * both ends need them and only one end is server code: the action metadata in
 * `index.ts` is what the editor loads into the browser, and it derives the
 * template-autocomplete fields from the output schema here, while the step in
 * `steps/` is typed against the same two constants.
 */

import { Schema } from "effect";

/**
 * The Send Email config, as the step reads it.
 *
 * Every field is a string because that is what a resolved config field is: the
 * editor writes text, and a template variable resolves to text. Which of them
 * the user has to fill in is stated in `configFields`; what this schema says is
 * what a step may read.
 *
 * `optional`, not `optionalKey`: the engine resolves a node's templates into
 * every config key the action declares, so a field the user left blank arrives
 * as a key holding `undefined` rather than as no key at all. Exact-optional
 * semantics would reject the config a real run builds.
 */
export const sendEmailInput = Schema.Struct({
  emailTo: Schema.String,
  emailSubject: Schema.String,
  emailFrom: Schema.optional(Schema.String),
  emailBody: Schema.optional(Schema.String),
  emailHtml: Schema.optional(Schema.String),
  emailContentMode: Schema.optional(Schema.String),
  emailTemplateId: Schema.optional(Schema.String),
  /** JSON the workflow author typed, parsed by the step. */
  emailTemplateVariables: Schema.optional(Schema.String),
  emailCc: Schema.optional(Schema.String),
  emailBcc: Schema.optional(Schema.String),
  emailReplyTo: Schema.optional(Schema.String),
  emailScheduledAt: Schema.optional(Schema.String),
  emailTopicId: Schema.optional(Schema.String),
  /** JSON the workflow author typed, parsed by the step. */
  emailTags: Schema.optional(Schema.String),
  testBehavior: Schema.optional(Schema.String),
  testEmailTo: Schema.optional(Schema.String),
});

/**
 * What a sent email leaves for the nodes downstream of it.
 *
 * `optional` here for the same reason as above, from the other direction: the
 * handler answers a `reasonCode` only on the paths where a test run did not
 * send, and `optionalKey` would describe a payload that omits the key entirely.
 */
export const sendEmailOutput = Schema.Struct({
  id: Schema.String.annotate({ description: "Email ID" }),
  /** Absent on a real send: this is why a test run did not make one. */
  reasonCode: Schema.optional(
    Schema.String.annotate({ description: "Why a test run did not send" })
  ),
});
