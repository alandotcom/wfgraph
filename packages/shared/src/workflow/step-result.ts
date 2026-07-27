/**
 * What a workflow step hands back, written down once.
 *
 * A step reaches the engine through a dynamic import keyed by an export name
 * recorded at registration time, so the compiler cannot follow the dispatch by
 * itself. The single place that lookup happens (`loadStepFunction` in
 * `step-registry`) states the contract in terms of these types. From there the
 * engine, the step logging wrapper, and the template resolver all read this one
 * declaration, so none of them has to re-derive the shape at run time.
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
 * `@/shared/types/timestamp` for that reason.
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
 * A step as the engine calls it.
 *
 * The input is an open record rather than a JSON object, because the engine
 * builds it as a node's resolved config plus `_context`, the logging handle the
 * step wrapper needs. The config half is JSON, having come from a jsonb column;
 * the context half is a live object. Each step narrows the record to the fields
 * it declares.
 */
export type StepFunction = (
  input: Record<string, unknown>
) => StepResult | Promise<StepResult>;
