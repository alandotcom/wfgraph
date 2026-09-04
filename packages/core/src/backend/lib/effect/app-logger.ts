import { Context, Effect, Layer, Logger, References } from "effect";
import { omitBy } from "es-toolkit/object";
import { isEmptyObject } from "es-toolkit/predicate";
import { getAppLogger } from "#src/backend/lib/logger";

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
 * `get("integrations", "oauth")` is the Effect-side spelling of
 * `getAppLogger("integrations", "oauth")`, so a category keeps its name across the
 * migration and the sink configuration a host installed keeps working.
 */
export class AppLogger extends Context.Service<
  AppLogger,
  {
    readonly get: (...category: string[]) => EffectLogger;
  }
>()("@wfgraph/core/AppLogger") {}

const APP_LOG_CATEGORY_ANNOTATION = "wfgraph.log.category";

function renderMessagePart(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value) ?? String(value);
}

function renderMessage(message: unknown): string {
  return Array.isArray(message)
    ? message.map(renderMessagePart).join(" ")
    : renderMessagePart(message);
}

function readCategory(value: unknown): string[] {
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === "string")
  ) {
    return value;
  }
  return ["effect"];
}

function unexpectedLogLevel(_level: never): never {
  throw new Error("Unexpected Effect log level");
}

const logtapeEffectLogger = Logger.make<unknown, void>(
  ({ fiber, logLevel, message }) => {
    const annotations = fiber.getRef(References.CurrentLogAnnotations);
    const category = readCategory(annotations[APP_LOG_CATEGORY_ANNOTATION]);
    const properties = omitBy(
      annotations,
      (_, key) => key === APP_LOG_CATEGORY_ANNOTATION
    );
    const lineProperties = isEmptyObject(properties) ? undefined : properties;
    const logger = getAppLogger(...category);
    const renderedMessage = renderMessage(message);

    switch (logLevel) {
      case "All":
      case "Trace":
      case "Debug":
        logger.debug(renderedMessage, lineProperties);
        break;
      case "Info":
        logger.info(renderedMessage, lineProperties);
        break;
      case "Warn":
        logger.warn(renderedMessage, lineProperties);
        break;
      case "Error":
      case "Fatal":
        logger.error(renderedMessage, lineProperties);
        break;
      case "None":
        break;
      default:
        unexpectedLogLevel(logLevel);
    }
  }
);

/**
 * Sends Effect-native logs to the same category-aware logtape sink as the
 * backend's direct loggers. Effect is left at its most permissive level because
 * logtape owns the host-configured severity filter.
 */
const AppEffectLoggerLayer: Layer.Layer<never> = Layer.merge(
  Logger.layer([logtapeEffectLogger]),
  Layer.succeed(References.MinimumLogLevel, "All")
);

/** Gives every Effect-native log in an operation its logtape category. */
export function withAppLogCategory<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  ...category: string[]
): Effect.Effect<A, E, R> {
  return Effect.annotateLogs(effect, APP_LOG_CATEGORY_ANNOTATION, category);
}

function wrapLogger(
  category: readonly string[],
  annotations: LogProperties = {}
): EffectLogger {
  const annotate = (effect: Effect.Effect<void>, properties?: LogProperties) =>
    withAppLogCategory(
      Effect.annotateLogs(effect, { ...annotations, ...properties }),
      ...category
    );

  return {
    debug: (message, properties) =>
      annotate(Effect.logDebug(message), properties),
    info: (message, properties) =>
      annotate(Effect.logInfo(message), properties),
    warn: (message, properties) =>
      annotate(Effect.logWarning(message), properties),
    error: (message, properties) =>
      annotate(Effect.logError(message), properties),
    with: (properties) =>
      wrapLogger(category, { ...annotations, ...properties }),
  };
}

export const AppLoggerLayer: Layer.Layer<AppLogger> = Layer.merge(
  Layer.succeed(AppLogger, {
    get: (...category) => wrapLogger(category),
  }),
  AppEffectLoggerLayer
);
