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
import type { RovaLogger } from "@/shared/types/logger";

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

  if (["0", "false", "no", "off"].includes(configured)) {
    return false;
  }

  return true;
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

export function configureAppLogging(): void {
  if (isConfigured) {
    return;
  }

  const logFormat = process.env.LOG_FORMAT?.trim().toLowerCase();
  const forcePretty = logFormat === "pretty";
  const prettyProperties = resolvePrettyProperties();
  const prettyInspectDepth = resolvePrettyInspectDepth();

  configureSync({
    sinks: {
      console: getConsoleSink({
        formatter: forcePretty
          ? getPrettyFormatter({
              timestamp: "date-time-tz",
              categorySeparator: ".",
              icons: false,
              align: false,
              properties: prettyProperties,
              inspectOptions: {
                depth: prettyInspectDepth,
                compact: false,
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

export function configureAppLoggingWithBridge(logger: RovaLogger): void {
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
