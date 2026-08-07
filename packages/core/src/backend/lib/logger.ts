/**
 * Console logging for the backend. The format follows the terminal: an attached
 * TTY gets the colourised pretty formatter, anything piped gets JSON lines.
 * `LOG_FORMAT` overrides that with `pretty` or `json`, and `LOG_LEVEL`,
 * `LOG_PRETTY_PROPERTIES` and `LOG_PRETTY_INSPECT_DEPTH` tune the rest.
 */

import {
  configureSync,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  isLogLevel,
  type LogLevel,
  type LogRecord,
  resetSync,
} from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import type { WfGraphLogger } from "@wfgraph/shared/types/logger";

const LOGGER_ROOT = "app";

let isConfigured = false;

function resolveDefaultLogLevel(): LogLevel {
  const configuredLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (configuredLevel && isLogLevel(configuredLevel)) {
    return configuredLevel;
  }

  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function resolvePrettyProperties(): boolean {
  const configured = process.env.LOG_PRETTY_PROPERTIES?.trim().toLowerCase();
  if (!configured) {
    return true;
  }

  return !["0", "false", "no", "off"].includes(configured);
}

function resolvePrettyInspectDepth(): number {
  const configured = process.env.LOG_PRETTY_INSPECT_DEPTH?.trim();
  if (!configured) {
    return 8;
  }

  const parsedDepth = Number.parseInt(configured, 10);
  if (Number.isNaN(parsedDepth) || parsedDepth < 1) {
    return 8;
  }

  return parsedDepth;
}

/**
 * Whether the console sink should render the pretty formatter.
 *
 * With no `LOG_FORMAT` set, the terminal decides: a person watching an attached
 * TTY gets the colourised layout, while a piped or redirected stream (a
 * container, a log shipper, a CI job) gets machine-readable JSON lines.
 */
function shouldFormatPretty(): boolean {
  const logFormat = process.env.LOG_FORMAT?.trim().toLowerCase();
  if (logFormat === "pretty") {
    return true;
  }
  if (logFormat === "json") {
    return false;
  }

  // @types/node calls this a boolean; Node leaves it undefined off a terminal.
  return process.stdout.isTTY;
}

export function configureAppLogging(): void {
  if (isConfigured) {
    return;
  }

  configureSync({
    sinks: {
      console: getConsoleSink({
        formatter: shouldFormatPretty()
          ? getPrettyFormatter({
              timestamp: "time",
              categorySeparator: ".",
              icons: false,
              align: true,
              // The longest category in the tree is app.workflow.event-listener.
              // The default 20 cuts the middle out of the deeper ones, which is
              // where the service name is.
              categoryWidth: 27,
              properties: resolvePrettyProperties(),
              inspectOptions: {
                depth: resolvePrettyInspectDepth(),
                compact: true,
              },
              wordWrap: false,
            })
          : getJsonLinesFormatter({
              categorySeparator: ".",
              properties: "flatten",
            }),
      }),
    },
    loggers: [
      {
        category: LOGGER_ROOT,
        sinks: ["console"],
        lowestLevel: resolveDefaultLogLevel(),
      },
      {
        category: "logtape",
        sinks: ["console"],
        lowestLevel: "error",
      },
      {
        category: ["logtape", "meta"],
        sinks: ["console"],
        lowestLevel: "error",
      },
    ],
  });

  isConfigured = true;
}

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

export function configureAppLoggingWithBridge(logger: WfGraphLogger): void {
  if (isConfigured) {
    resetSync();
  }

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

  configureSync({
    sinks: { bridge: bridgeSink },
    loggers: [
      {
        category: LOGGER_ROOT,
        sinks: ["bridge"],
        lowestLevel: resolveDefaultLogLevel(),
      },
      {
        category: "logtape",
        sinks: ["bridge"],
        lowestLevel: "error",
      },
      {
        category: ["logtape", "meta"],
        sinks: ["bridge"],
        lowestLevel: "error",
      },
    ],
  });

  isConfigured = true;
}

export function getAppLogger(...category: string[]) {
  configureAppLogging();
  return getLogger([LOGGER_ROOT, ...category]);
}
