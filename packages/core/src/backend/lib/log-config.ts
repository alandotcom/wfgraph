/**
 * The parts of a logtape configuration that a host does not write by hand: the
 * level read off the environment, the two logtape meta loggers, the bridge that
 * sends every record to a `WfGraphLogger` a host passed, and the notice printed
 * when nobody configured anything.
 *
 * Nothing here imports a formatter, so the Worker bundle stays free of
 * `@logtape/pretty` and the `node:util` it reaches for. `@wfgraph/core/logging`
 * is where the console formatters live.
 */

import {
  configureSync,
  getConfig,
  isLogLevel,
  type LogLevel,
  type LoggerConfig,
  type LogRecord,
  resetSync,
} from "@logtape/logtape";
import { WFGRAPH_LOG_ROOT } from "#src/backend/lib/logger";
import type { WfGraphLogger } from "@wfgraph/shared/types/logger";

/**
 * `LOG_LEVEL` when it names one, and otherwise `info`.
 *
 * Development used to default to `debug`. The records that made that useful
 * were the engine's step-by-step narration, and one record now covers a whole
 * node, so `debug` no longer earns the volume by default.
 */
export function resolveLogLevel(): LogLevel {
  const configuredLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (configuredLevel && isLogLevel(configuredLevel)) {
    return configuredLevel;
  }

  return "info";
}

/**
 * logtape announces itself through the meta logger on every configure, and
 * warns when the meta logger is left unconfigured. Holding both at `error`
 * keeps the startup notice out of the stream while a sink that throws still
 * says so.
 */
export function loggerConfigs(
  sink: string,
  lowestLevel: LogLevel
): LoggerConfig<string, string>[] {
  return [
    { category: WFGRAPH_LOG_ROOT, sinks: [sink], lowestLevel },
    { category: "logtape", sinks: [sink], lowestLevel: "error" },
    { category: ["logtape", "meta"], sinks: [sink], lowestLevel: "error" },
  ];
}

/**
 * Renders logtape's alternating template/value message array into one string.
 * The bridge target takes a message and a property bag, so the placeholders
 * have to be filled in before the record leaves.
 */
function renderLogMessage(message: readonly unknown[]): string {
  let result = "";
  for (let i = 0; i < message.length; i += 2) {
    result += message[i];
    if (i + 1 < message.length) {
      const value = message[i + 1];
      result +=
        typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    }
  }
  return result;
}

/**
 * Sends every Workflow Graph record to the logger a host passed as
 * `createWfGraphApp`'s `logger` option.
 *
 * This installs a logtape configuration and replaces any other, because a host
 * asking for the bridge is asking for its records to arrive somewhere specific.
 * A host with its own logtape setup should leave `logger` unset and add a sink
 * for the `wfgraph` category instead.
 */
export function configureLoggingWithBridge(
  logger: WfGraphLogger,
  level: LogLevel = resolveLogLevel()
): void {
  const bridgeSink = (record: LogRecord): void => {
    const category = record.category.join(".");
    const message = `[${category}] ${renderLogMessage(record.message)}`;
    const properties =
      Object.keys(record.properties).length > 0 ? record.properties : undefined;

    switch (record.level) {
      case "trace":
      case "debug":
        logger.debug?.(message, properties);
        break;
      case "info":
        logger.info(message, properties);
        break;
      case "warning":
        logger.warn(message, properties);
        break;
      case "error":
      case "fatal":
        logger.error(message, properties);
        break;
      default:
        logger.info(message, properties);
        break;
    }
  };

  if (getConfig() !== null) {
    resetSync();
  }

  configureSync({
    sinks: { bridge: bridgeSink },
    loggers: loggerConfigs("bridge", level),
  });
}

let hasWarnedAboutMissingConfig = false;

/**
 * Says so, once, when an app boots with no logtape configuration installed.
 *
 * Workflow Graph configures nothing on its own, so this is the difference
 * between an adopter reading a sentence that names the fix and an adopter
 * watching a silent process and guessing.
 */
export function warnWhenLoggingUnconfigured(): void {
  if (hasWarnedAboutMissingConfig || getConfig() !== null) {
    return;
  }

  hasWarnedAboutMissingConfig = true;
  console.warn(
    'Workflow Graph logs through LogTape and no configuration is installed, so nothing it logs will be recorded. Call configureWfGraphLogging() from @wfgraph/core/logging before creating the app, pass a logger to createWfGraphApp, or configure LogTape yourself with a sink for the "wfgraph" category.'
  );
}
