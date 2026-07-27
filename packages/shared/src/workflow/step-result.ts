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

/** The wrapper every step follows: a payload on success, a reason on failure. */
export type StepResult<TData = unknown> =
  | { success: true; data?: TData }
  | { success: false; error: StepError };

/**
 * The Condition step's answer, which is the one exception to the wrapper.
 *
 * The engine evaluates the condition expression itself and calls the step with
 * the boolean it already has; the step exists so the decision lands in the run
 * log, and it echoes the boolean back. Naming that shape here lets the engine
 * and the logging wrapper tell the two apart by the property each carries.
 */
export type ConditionStepResult = { condition: boolean };

/** Either shape a step function can return. */
export type StepReturn = StepResult | ConditionStepResult;

/**
 * A step as the engine calls it.
 *
 * The input is an open record because the engine builds it from a node's stored
 * config after resolving templates; each step narrows that record to the fields
 * it declares.
 */
export type StepFunction = (
  input: Record<string, unknown>
) => StepResult | Promise<StepResult>;
