/**
 * What a workflow step hands back, written down once.
 *
 * A step reaches the engine through `WorkflowActions.stepFor`, which answers by
 * action id off the assembled surface, so nothing on that path carries the
 * step's own types. This declaration is what the two ends agree on: `defineStep`
 * builds the envelope, and the engine and the template resolver read it, so none
 * of them has to re-derive the shape at run time.
 */

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
 * but not to an interface, so `TData extends JsonValue` would reject
 * `Appointment` from the Acuity SDK while accepting an identical local alias.
 * That rejects nothing unsafe. The constraint therefore lives at the reading
 * end, on `NodeOutputs`, where the engine has already carried the value across
 * the serialization boundary and every consumer needs to narrow it.
 */
export type StepResult<TData = unknown> =
  | { success: true; data?: TData }
  | { success: false; error: StepError };

/**
 * What a node's work is remembered by, so a replay reuses it.
 *
 * The engine hands one of these to every node. Nothing outside `run` is
 * remembered: a replay executes the handler again from the top and reaches each
 * `run` already answered, which is Inngest's contract and now an author's.
 *
 * `stepId` is the author's own name for the work, which the engine prefixes with
 * the node it belongs to, so two nodes running the same action do not collide.
 */
export type NodeSteps = {
  run: <T>(stepId: string, work: () => Promise<T>) => Promise<T>;
};

/**
 * A step as the engine calls it.
 *
 * The input is an open record rather than a JSON object, because the engine
 * builds it as a node's resolved config plus `_context`, which tells the step
 * which node and which run it is part of. The config half is JSON, having come
 * from a jsonb column; the context half is a live object. Each step narrows the
 * record to the fields it declares.
 *
 * `node` travels beside the record rather than inside it, because the record is
 * written to the run log as jsonb and neither a function nor a database client is
 * JSON. A caller with no durable runtime leaves it out, and the work then runs
 * where it stands.
 */
export type StepFunction = (
  input: Record<string, unknown>,
  node?: NodeRuntime
) => StepResult | Promise<StepResult>;

/** What a node is given beside its config: how to remember work, and what the
 * host's middleware put there. */
export type NodeRuntime = {
  readonly steps: NodeSteps;
  readonly ctx: Readonly<Record<string, unknown>>;
};
