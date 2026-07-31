/**
 * The three events Rova sends to itself, with the schemas that define them.
 *
 * An `eventType` is one definition used from both ends: the sender builds its
 * payload with `.create()`, and the function that triggers on it declares the
 * same object. Inngest validates the payload on send and again before it calls
 * a handler, so a shape that drifts between the two is a failure rather than an
 * `undefined` several frames deep in the engine.
 *
 * Inngest asks for a Standard Schema and calls `~standard.validate(payload)`
 * with nothing else to say, so each schema crosses `toStandardSchema` here with
 * the decode options baked in. That crossing happens once per schema, at the
 * `eventType` below, which is the only place these shapes are used.
 *
 * The optional fields are `Schema.optional` rather than `Schema.optionalKey`,
 * which is the opposite of the wire schemas in `@rova/shared`. Those read a
 * payload that has already been through `JSON.parse`, where a key is either
 * present or absent and never `undefined`. This one is checked before the
 * payload is serialized, against an object literal TypeScript built, and
 * `{ correlationKey: undefined }` is how TypeScript spells a field the caller
 * had no value for. `optionalKey` calls that a missing string.
 *
 * These live in `@rova/core` because they import the SDK. `@rova/shared` has no
 * Inngest dependency and should not gain one.
 */
import { Schema } from "effect";
import { eventType } from "inngest";
import { jsonObjectSchema } from "@rova/shared/types/json";
import {
  NonEmptyTrimmedString,
  rejectUnknownKeys,
  toStandardSchema,
} from "@rova/shared/types/schema";
import { serializedWorkflowGraphSchema } from "@rova/shared/graph/schemas";

/**
 * The `workflow/run.requested` payload, as the engine needs it.
 *
 * Inngest serializes this to JSON when the run is enqueued and hands it back on
 * every attempt and every replay, so the handler learns nothing about its shape
 * from the type system. This schema is that boundary check, and attaching it to
 * the event type is what makes the check happen before the handler runs.
 */
export const workflowExecutionInputSchema = Schema.Struct({
  graph: serializedWorkflowGraphSchema,
  // JSON is all that survived the trip, so JSON is what the schema accepts.
  triggerInput: Schema.optional(jsonObjectSchema),
  requestPayload: Schema.optional(jsonObjectSchema),
  // Both ids are required and must carry a value: every log row, timeline event,
  // and wait state the run writes hangs off them, and the enqueue side always
  // supplies them. An empty id would attach a run's whole trace to nothing.
  executionId: NonEmptyTrimmedString,
  workflowId: NonEmptyTrimmedString,
  workflowName: Schema.optional(Schema.String),
  workflowRunId: Schema.optional(Schema.String),
  runMode: Schema.optional(Schema.Literals(["live", "test"])),
});

export const workflowRunRequested = eventType("workflow/run.requested", {
  schema: toStandardSchema(workflowExecutionInputSchema, rejectUnknownKeys),
});

export const workflowRunCancelRequested = eventType(
  "workflow/run.cancel.requested",
  {
    schema: toStandardSchema(
      Schema.Struct({
        executionId: NonEmptyTrimmedString,
        workflowId: NonEmptyTrimmedString,
        reason: Schema.String,
        requestedBy: Schema.String,
        eventType: Schema.optional(Schema.String),
        correlationKey: Schema.optional(Schema.String),
      }),
      rejectUnknownKeys
    ),
  }
);

export const workflowWaitSignal = eventType("workflow/wait.signal", {
  schema: toStandardSchema(
    Schema.Struct({
      executionId: NonEmptyTrimmedString,
      nodeId: NonEmptyTrimmedString,
      // A wait can be resumed without a token, and the store hands back null
      // rather than dropping the column, so null is a value here.
      token: Schema.optional(Schema.NullOr(Schema.String)),
      eventType: Schema.optional(Schema.String),
      correlationKey: Schema.optional(Schema.String),
      payload: Schema.optional(jsonObjectSchema),
      // One envelope wakes a parked run for either reason. The signal carries
      // no decision of its own: a `lifecycle-cancel` wake sends the run back to
      // the flag on its execution row, which is the single answer to whether it
      // is canceled.
      signalType: Schema.Literals(["wait-resume", "lifecycle-cancel"]),
    }),
    rejectUnknownKeys
  ),
});
