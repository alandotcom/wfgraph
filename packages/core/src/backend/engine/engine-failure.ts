import { Cause, Context, Effect, Exit, Option, Result, Schema } from "effect";
import { getErrorMessage } from "@wfgraph/shared/utils";

/**
 * What kind of failure ended a node, a step or a run.
 *
 * - `failure`: an expected failure, such as a step that threw or a write the
 *   database refused.
 * - `defect`: an unexpected error the Effect runtime caught.
 * - `interrupt`: the durable runtime tore the invocation down.
 * - `version_refused`: a version fence refused a write, because a Migration
 *   moved the run off the Workflow Version this body loaded. Nothing failed,
 *   and the next pass loads the version the run now pins.
 * - `lease_lost`: under the database executor, the pass no longer acts on the
 *   run (`LeaseLost`). It ends the pass and never fails a node.
 */
export type EngineFailureKind =
  | "failure"
  | "defect"
  | "interrupt"
  | "version_refused"
  | "lease_lost";

const ENGINE_FAILURE_KINDS = [
  "failure",
  "defect",
  "interrupt",
  "version_refused",
  "lease_lost",
] as const satisfies readonly EngineFailureKind[];

export const engineFailureSchema = Schema.Struct({
  kind: Schema.Literals(ENGINE_FAILURE_KINDS),
  message: Schema.String,
});

export type EngineFailure = typeof engineFailureSchema.Type;

function isEngineFailureKind(value: unknown): value is EngineFailureKind {
  return ENGINE_FAILURE_KINDS.some((kind) => kind === value);
}

export function isEngineFailure(value: unknown): value is EngineFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    isEngineFailureKind(value.kind) &&
    "message" in value &&
    typeof value.message === "string"
  );
}

/**
 * Whether a value is the store's `LeaseLost` failure. Read by its tag so the
 * engine imports nothing from the database layer.
 */
function isLeaseLost(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "LeaseLost"
  );
}

export function engineFailure(
  kind: EngineFailureKind,
  message: string
): EngineFailure {
  return { kind, message };
}

export function failureFromUnknown(error: unknown): EngineFailure {
  if (isEngineFailure(error)) {
    return error;
  }
  return engineFailure(
    isLeaseLost(error) ? "lease_lost" : "failure",
    getErrorMessage(error)
  );
}

/**
 * Whether a failure ends this pass of the body with nothing more written,
 * rather than failing a node or the run. An interrupted invocation is retried
 * by the durable runtime, a pass that lost its lease leaves the run to the
 * owner that holds it now, and a refused version fence leaves it to the pass
 * that loads the version the run was moved to.
 */
export function endsPass(failure: EngineFailure): boolean {
  return (
    failure.kind === "interrupt" ||
    failure.kind === "lease_lost" ||
    failure.kind === "version_refused"
  );
}

/**
 * Reduces a full Effect cause at the node or run boundary.
 *
 * Defects outrank typed failures, and a typed failure outranks a concurrent
 * interruption. Only an interruption-only cause becomes an interrupted run.
 */
export function failureFromCause<E>(cause: Cause.Cause<E>): EngineFailure {
  const defect = Cause.findDefect(cause);
  if (Result.isSuccess(defect)) {
    return engineFailure("defect", getErrorMessage(defect.success));
  }

  const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (failure !== undefined) {
    return failureFromUnknown(failure);
  }

  if (Cause.hasInterruptsOnly(cause)) {
    return engineFailure("interrupt", "Workflow execution was interrupted");
  }

  return engineFailure("failure", getErrorMessage(Cause.squash(cause)));
}

/**
 * Runs an Effect inside a Promise-shaped durability callback without losing its
 * cause or the invocation context that owns its logging and tracing references.
 */
export function runPromiseWithEngineFailure<R>(context: Context.Context<R>) {
  return async <A, E>(effect: Effect.Effect<A, E, R>): Promise<A> => {
    const exit = await Effect.runPromiseExitWith(context)(effect);
    return Exit.isFailure(exit)
      ? Promise.reject(failureFromCause(exit.cause))
      : exit.value;
  };
}
