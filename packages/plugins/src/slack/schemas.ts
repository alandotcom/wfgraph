/**
 * What the Slack actions take and what they give back.
 *
 * These sit beside the plugin's metadata rather than beside its steps because
 * both ends need them and only one end is server code: the action metadata in
 * `index.ts` is what the editor loads into the browser, and it derives the
 * template-autocomplete fields from the output schema here, while the step in
 * `steps/` is typed against the same two constants.
 */

import { Schema } from "effect";

/**
 * The Send Slack Message config, as the step reads it.
 *
 * `optional`, not `optionalKey`: the engine resolves a node's templates into
 * every config key the action declares, so a field the user left blank arrives
 * as a key holding `undefined` rather than as no key at all. Exact-optional
 * semantics would reject the config a real run builds.
 */
export const sendSlackMessageInput = Schema.Struct({
  slackChannel: Schema.String,
  slackMessage: Schema.String,
  testBehavior: Schema.optional(Schema.String),
});

/**
 * What a posted message leaves for the nodes downstream of it.
 *
 * The StepResult envelope keeps `success` out of the flat CEL condition
 * namespace mergeConditionContextValue builds; the old flat shape leaked it
 * in. `defineStep` builds that envelope, so the paths name only the payload.
 */
export const sendSlackMessageOutput = Schema.Struct({
  ts: Schema.String.annotate({ description: "Message timestamp" }),
  channel: Schema.String.annotate({ description: "Channel ID" }),
  /** Absent on a real send: this is why a test run did not make one. */
  reasonCode: Schema.optional(
    Schema.String.annotate({ description: "Why a test run did not send" })
  ),
});
