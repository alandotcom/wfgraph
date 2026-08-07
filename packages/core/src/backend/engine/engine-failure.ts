import { Cause, Context, Effect, Exit, Option, Result, Schema } from "effect";
import { getErrorMessage } from "@wfgraph/shared/utils";

export type EngineFailureKind = "failure" | "defect" | "interrupt";

export const engineFailureSchema = Schema.Struct({
  kind: Schema.Union([
    Schema.Literal("failure"),
    Schema.Literal("defect"),
    Schema.Literal("interrupt"),
  ]),
  message: Schema.String,
});

export type EngineFailure = typeof engineFailureSchema.Type;

function isEngineFailureKind(value: unknown): value is EngineFailureKind {
  return value === "failure" || value === "defect" || value === "interrupt";
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

export function engineFailure(
  kind: EngineFailureKind,
  message: string
): EngineFailure {
  return { kind, message };
}

export function failureFromUnknown(error: unknown): EngineFailure {
  return isEngineFailure(error)
    ? error
    : engineFailure("failure", getErrorMessage(error));
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
