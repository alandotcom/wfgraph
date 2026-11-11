/**
 * What a workflow step hands back, written down once.
 *
 * A step reaches the engine through `WorkflowActions.stepFor`, which answers by
 * action id off the assembled surface, so nothing on that path carries the
 * step's own types. This declaration is what the two ends agree on: `defineStep`
 * builds the envelope, and the engine and the template resolver read it, so none
 * of them has to re-derive the shape at run time.
 */

import type { JsonSafe } from "#src/types/json";

/**
 * How a failed step says why. A step that fails always supplies a message, and
 * the object form leaves room for siblings alongside it.
 */
export type StepError = { message: string };

/**
 * The wrapper every step follows: a payload on success, a reason on failure.
 *
 * The payload has to be JSON at run time, because a step result is memoized by
 * Inngest between steps and then stored as a node output that templates and CEL
 * conditions read back. A Date or a Map placed here loses its type before any
 * downstream node sees it, and timestamps cross through the codec in
 * `#src/types/timestamp` for that reason.
 *
 * `TData` stays unconstrained even so. Most step payloads are shaped by a
 * vendor SDK, and TypeScript gives an implicit index signature to a type alias
 * but not to an interface, so `TData extends JsonValue` would reject an
 * interface a vendor SDK declares while accepting an identical local alias.
 * That rejects nothing unsafe. The constraint therefore lives at the reading
 * end, on `NodeOutputs`, where the engine has already carried the value across
 * the serialization boundary and every consumer needs to narrow it.
 */
export type StepResult<TData = unknown> =
  | { success: true; data?: TData | undefined }
  | { success: false; error: StepError };

/**
 * What a node's work is remembered by, so a replay reuses it.
 *
 * The engine hands one of these to every node. `run` is an author's
 * `step.run`: `stepId` is the author's own name for the work, which the engine
 * places under the node it belongs to, so two nodes running the same action do
 * not collide. `runHandler` is the node's whole answer as one step, which a
 * host action's handler runs inside, so a handler that answered once is not
 * called again for that node of that run. An integration's handler does not use
 * it, and nothing outside its own `run` calls is remembered.
 *
 * `JsonSafe` is what holds the round trip to values that survive it. The answer
 * is stored as JSON and read back on the next attempt, so a `Date` in it would
 * arrive as a string with its type still claiming otherwise. `runHandler`'s
 * value is the envelope the boundary builds, which carries no author type.
 *
 * `work` is handed the signal the runtime aborts when it stops the step while
 * it runs; work that passes it on ends early.
 */
export type NodeSteps = {
  run: <T>(
    stepId: string,
    work: (signal: AbortSignal) => Promise<T & JsonSafe<T>>
  ) => Promise<T>;
  runHandler: <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
};
