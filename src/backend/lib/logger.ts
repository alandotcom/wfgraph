import {
  configureSync,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  isLogLevel,
  type LogLevel,
} from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";

const LOGGER_ROOT = "app";

let isConfigured = false;

function resolveDefaultLogLevel(): LogLevel {
  const configuredLevel = Bun.env.LOG_LEVEL?.trim().toLowerCase();
  if (configuredLevel && isLogLevel(configuredLevel)) {
    return configuredLevel;
  }

  return Bun.env.NODE_ENV === "production" ? "info" : "debug";
}

function resolvePrettyProperties(): boolean {
  const configured = Bun.env.LOG_PRETTY_PROPERTIES?.trim().toLowerCase();
  if (!configured) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(configured)) {
    return false;
  }

  return true;
}

function resolvePrettyInspectDepth(): number {
  const configured = Bun.env.LOG_PRETTY_INSPECT_DEPTH?.trim();
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

  const logFormat = Bun.env.LOG_FORMAT?.trim().toLowerCase();
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

export function getAppLogger(...category: string[]) {
  configureAppLogging();
  return getLogger([LOGGER_ROOT, ...category]);
}
