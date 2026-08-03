import { Cause, Context, Effect, Exit, Option, Schema } from "effect";
import { getErrorMessage } from "@rova/shared/utils";

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
 * Defects outrank interrupts, and interrupts outrank typed failures, so a
 * combined cause preserves the invariant failure that triggered cancellation.
 */
export function failureFromCause<E>(cause: Cause.Cause<E>): EngineFailure {
  if (Cause.hasDies(cause)) {
    return engineFailure("defect", getErrorMessage(Cause.squash(cause)));
  }

  if (Cause.hasInterrupts(cause)) {
    return engineFailure("interrupt", "Workflow execution was interrupted");
  }

  const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
  return failureFromUnknown(failure);
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
