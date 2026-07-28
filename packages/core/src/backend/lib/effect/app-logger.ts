import { Context, Effect, Layer } from "effect";
import { getAppLogger } from "@/backend/lib/logger";

/** Structured fields attached to one log line, the same bag logtape takes. */
export type LogProperties = Record<string, unknown>;

/**
 * A logger whose calls are Effects.
 *
 * The log itself is a side effect, so writing one inside an `Effect.gen` body
 * has to be a `yield*` like any other step. Underneath this is the same logtape
 * logger the rest of the backend uses, so a migrated service and an unmigrated
 * one produce the same lines on the same sinks.
 */
export type EffectLogger = {
  readonly debug: (
    message: string,
    properties?: LogProperties
  ) => Effect.Effect<void>;
  readonly info: (
    message: string,
    properties?: LogProperties
  ) => Effect.Effect<void>;
  readonly warn: (
    message: string,
    properties?: LogProperties
  ) => Effect.Effect<void>;
  readonly error: (
    message: string,
    properties?: LogProperties
  ) => Effect.Effect<void>;
  /** A logger that repeats these fields on every line, as logtape's `with` does. */
  readonly with: (properties: LogProperties) => EffectLogger;
};

/**
 * The application log, reached by category.
 *
 * `get("api-keys", "auth")` is the Effect-side spelling of
 * `getAppLogger("api-keys", "auth")`, so a category keeps its name across the
 * migration and the sink configuration a host installed keeps working.
 */
export class AppLogger extends Context.Service<
  AppLogger,
  {
    readonly get: (...category: string[]) => EffectLogger;
  }
>()("AppLogger") {}

type LogtapeLogger = ReturnType<typeof getAppLogger>;

function wrapLogger(logger: LogtapeLogger): EffectLogger {
  return {
    debug: (message, properties) =>
      Effect.sync(() => logger.debug(message, properties)),
    info: (message, properties) =>
      Effect.sync(() => logger.info(message, properties)),
    warn: (message, properties) =>
      Effect.sync(() => logger.warn(message, properties)),
    error: (message, properties) =>
      Effect.sync(() => logger.error(message, properties)),
    with: (properties) => wrapLogger(logger.with(properties)),
  };
}

export const AppLoggerLayer: Layer.Layer<AppLogger> = Layer.succeed(AppLogger, {
  get: (...category) => wrapLogger(getAppLogger(...category)),
});
