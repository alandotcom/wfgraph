/**
 * The three events Rova sends to itself, with the schemas that define them.
 *
 * An `eventType` is one definition used from both ends: the sender builds its
 * payload with `.create()`, and the function that triggers on it declares the
 * same object. Inngest validates the payload on send and again before it calls
 * a handler, so a shape that drifts between the two is a failure rather than an
 * `undefined` several frames deep in the engine.
 *
 * These live in `@rova/core` because they import the SDK. `@rova/shared` has no
 * Inngest dependency and should not gain one.
 */
import { eventType } from "inngest";
import { z } from "zod";
import { jsonObjectZodSchema } from "@rova/shared/types/json";
import { serializedWorkflowGraphSchema } from "@rova/shared/workflow/schemas";

/**
 * The `workflow/run.requested` payload, as the engine needs it.
 *
 * Inngest serializes this to JSON when the run is enqueued and hands it back on
 * every attempt and every replay, so the handler learns nothing about its shape
 * from the type system. This schema is that boundary check, and attaching it to
 * the event type is what makes the check happen before the handler runs.
 */
export const workflowExecutionInputSchema = z.object({
  graph: serializedWorkflowGraphSchema,
  // JSON is all that survived the trip, so JSON is what the schema accepts.
  triggerInput: jsonObjectZodSchema.optional(),
  requestPayload: jsonObjectZodSchema.optional(),
  // Both ids are required and must carry a value: every log row, timeline event,
  // and wait state the run writes hangs off them, and the enqueue side always
  // supplies them. An empty id would attach a run's whole trace to nothing.
  executionId: z.string().trim().min(1),
  workflowId: z.string().trim().min(1),
  workflowName: z.string().optional(),
  workflowRunId: z.string().optional(),
  runMode: z.enum(["live", "test"]).optional(),
  eventContext: z
    .object({
      eventType: z.string().optional(),
      correlationKey: z.string().optional(),
    })
    .optional(),
});

export const workflowRunRequested = eventType("workflow/run.requested", {
  schema: workflowExecutionInputSchema,
});

export const workflowRunCancelRequested = eventType(
  "workflow/run.cancel.requested",
  {
    schema: z.object({
      executionId: z.string().trim().min(1),
      workflowId: z.string().trim().min(1),
      reason: z.string(),
      requestedBy: z.string(),
      eventType: z.string().optional(),
      correlationKey: z.string().optional(),
    }),
  }
);

export const workflowWaitSignal = eventType("workflow/wait.signal", {
  schema: z.object({
    executionId: z.string().trim().min(1),
    nodeId: z.string().trim().min(1),
    // A wait can be resumed without a token, and the store hands back null
    // rather than dropping the column, so null is a value here.
    token: z.string().nullish(),
    eventType: z.string().optional(),
    correlationKey: z.string().optional(),
    payload: jsonObjectZodSchema.optional(),
    signalType: z.literal("wait-resume"),
  }),
});
