/**
 * The events Workflow Graph sends to itself, with the schemas that define them.
 *
 * An `eventType` is one definition used from both ends: the sender builds its
 * payload with `.create()`, and the function that triggers on it declares the
 * same object. Inngest validates the payload on send and again before it calls
 * a handler, so a shape that drifts between the two is a failure rather than an
 * `undefined` several frames deep in the engine. `invoke()` is the same crossing
 * for a function that is not a public event.
 *
 * Inngest asks for a Standard Schema and calls `~standard.validate(payload)`
 * with nothing else to say, so each schema crosses `toStandardSchema` here with
 * the decode options baked in. That crossing happens once per schema, at the
 * `eventType` or `invoke` below, which is the only place these shapes are used.
 *
 * The optional fields are `Schema.optional` rather than `Schema.optionalKey`,
 * which is the opposite of the wire schemas in `@wfgraph/shared`. Those read a
 * payload that has already been through `JSON.parse`, where a key is either
 * present or absent and never `undefined`. This one is checked before the
 * payload is serialized, against an object literal TypeScript built, and
 * `{ entityValue: undefined }` is how TypeScript spells a field the caller
 * had no value for. `optionalKey` calls that a missing string.
 *
 * These live in `@wfgraph/core` because they import the SDK. `@wfgraph/shared` has no
 * Inngest dependency and should not gain one.
 */
import { Schema } from "effect";
import { eventType, invoke } from "inngest";
import { jsonObjectSchema } from "@wfgraph/shared/types/json";
import {
  NonEmptyTrimmedString,
  rejectUnknownKeys,
  toStandardSchema,
} from "@wfgraph/shared/types/schema";

/**
 * The `workflow/run.requested` payload: the id of a row that already exists.
 *
 * Inngest serializes this to JSON when the run is enqueued and hands it back on
 * every attempt and every replay, so the handler learns nothing about its shape
 * from the type system. This schema is that boundary check, and attaching it to
 * the event type is what makes the check happen before the handler runs. The
 * graph, the start payload and the workflow identity are reloaded from that
 * row, not taken from the event.
 */
export const workflowRunRequestSchema = Schema.Struct({
  executionId: NonEmptyTrimmedString,
});

export const workflowRunRequested = eventType("workflow/run.requested", {
  schema: toStandardSchema(workflowRunRequestSchema, rejectUnknownKeys),
});

/**
 * Where Inngest states the invocation an event belongs to. Its spelling, and
 * the one key on this payload Workflow Graph neither writes nor reads.
 */
export const INNGEST_META_KEY = "_inngest";

/**
 * The `workflow-branch` invoke payload: the execution the branch belongs to,
 * plus the Wait node it starts at.
 *
 * The graph is not on this payload. The handler reloads it from the pinned
 * published version, the same as the parent run, so an invoke cannot choose
 * which steps fire. What those nodes left behind stays in the store for the
 * branch to read back, because an HTTP Request step's response body is what
 * makes those outputs large and the wire is the wrong place for it. The ids
 * below are what the store cannot answer.
 *
 * The invoke metadata is declared rather than the shape left open: an event
 * `step.invoke` produced carries it, the decode below rejects every other
 * unknown key, and an Inngest release that adds a second one fails here rather
 * than somewhere the reason is harder to see.
 */
export const workflowBranchInputSchema = Schema.Struct({
  executionId: NonEmptyTrimmedString,
  entryNodeId: NonEmptyTrimmedString,
  /**
   * Which nodes above the entry have let their downstream follow. Ids alone, so
   * the size argument against carrying outputs does not reach it, and the stored
   * rows cannot answer it: a node that halted its branch has an output too.
   */
  releasedNodeIds: Schema.Array(NonEmptyTrimmedString),
  [INNGEST_META_KEY]: Schema.optional(jsonObjectSchema),
});

/**
 * The branch function's only trigger: `step.invoke`, not a public event.
 *
 * `getConfigTriggers` omits `inngest/function.invoked` from the registered
 * trigger list, so an event key or unsigned bus cannot start a branch.
 */
export const workflowBranchInvoked = invoke(
  toStandardSchema(workflowBranchInputSchema, rejectUnknownKeys)
);

/**
 * The event that kills a run's branch invocations, and only those.
 *
 * Distinct from `workflowRunCancelRequested` because the run that started them
 * has to survive what kills them: it is the one thing left alive that can close
 * their rows and route the Execution into its Canceled outlet.
 */
export const workflowBranchKillRequested = eventType(
  "workflow/branch.kill.requested",
  {
    schema: toStandardSchema(
      Schema.Struct({
        executionId: NonEmptyTrimmedString,
        workflowId: NonEmptyTrimmedString,
        reason: Schema.String,
      }),
      rejectUnknownKeys
    ),
  }
);

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
        entityValue: Schema.optional(Schema.String),
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
      entityValue: Schema.optional(Schema.String),
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
