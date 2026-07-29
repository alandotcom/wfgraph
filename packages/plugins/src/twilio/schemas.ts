/**
 * What the Twilio actions take and what they give back.
 *
 * These sit beside the plugin's metadata rather than beside its steps because
 * both ends need them and only one end is server code: the action metadata in
 * `index.ts` is what the editor loads into the browser, and it derives the
 * template-autocomplete fields from the output schema here, while the step in
 * `steps/` is typed against the same two constants.
 */

import { Schema } from "effect";

/**
 * The Send SMS config, as the step reads it.
 *
 * Every field is a string because that is what a resolved config field is: the
 * editor writes text, and a template variable resolves to text. Which of them
 * the user has to fill in is stated in `configFields`, and the run cannot start
 * until they are; what this schema says is what a step may read.
 *
 * `optional`, not `optionalKey`: the engine resolves a node's templates into
 * every config key the action declares, so a field the user left blank arrives
 * as a key holding `undefined` rather than as no key at all. Exact-optional
 * semantics would reject the config a real run builds.
 */
export const sendSmsInput = Schema.Struct({
  smsTo: Schema.String,
  smsBody: Schema.String,
  smsFrom: Schema.optional(Schema.String),
  smsMessagingServiceSid: Schema.optional(Schema.String),
  smsStatusCallback: Schema.optional(Schema.String),
  /** Comma-separated, which is how a single text field carries a list. */
  smsMediaUrls: Schema.optional(Schema.String),
  testBehavior: Schema.optional(Schema.String),
  testPhoneTo: Schema.optional(Schema.String),
});

/**
 * What a sent message leaves for the nodes downstream of it.
 *
 * `optional` here for the same reason as above, from the other direction: the
 * handler answers `from: undefined` on the path where Twilio sent no number,
 * and `optionalKey` would describe a payload that omits the key entirely. The
 * two look alike only because `exactOptionalPropertyTypes` is off, which is the
 * compiler agreeing not to notice.
 */
export const sendSmsOutput = Schema.Struct({
  sid: Schema.String.annotate({ description: "Message SID" }),
  status: Schema.String.annotate({ description: "Delivery status" }),
  to: Schema.String.annotate({ description: "Recipient phone number" }),
  from: Schema.optional(
    Schema.String.annotate({ description: "Sender phone number" })
  ),
  messagingServiceSid: Schema.optional(
    Schema.String.annotate({ description: "Messaging Service SID" })
  ),
  /** Absent on a real send: this is why a test run did not make one. */
  reasonCode: Schema.optional(
    Schema.String.annotate({ description: "Why a test run did not send" })
  ),
});
