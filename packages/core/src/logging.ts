/**
 * The console logging a host can install for Workflow Graph, in one call.
 *
 * `@wfgraph/core` configures no logging of its own. It asks logtape for a
 * logger under the `wfgraph` category and leaves the sinks, the levels and the
 * format to the application, which is what the logtape manual asks a library to
 * do. This entry is the shortcut for a host that wants a reasonable console and
 * no opinion of its own; a host with its own logtape setup adds a sink for the
 * `wfgraph` category instead of calling anything here.
 */

import {
  configureSync,
  getConsoleSink,
  getJsonLinesFormatter,
  isLogLevel,
  type LogLevel,
} from "@logtape/logtape";
import { loggerConfigs, resolveLogLevel } from "#src/backend/lib/log-config";
import { createPrettyFormatter } from "#src/backend/lib/pretty-formatter";

export type WfGraphLoggingOptions = {
  /** Lowest level the `wfgraph` category records. `LOG_LEVEL`, else `info`. */
  level?: LogLevel | undefined;
  /**
   * `pretty` for the colourised layout a person reads, `json` for one JSON
   * object per line. `LOG_FORMAT` decides when this is unset, and the terminal
   * decides when that is unset too.
   */
  format?: "pretty" | "json" | undefined;
};

/**
 * Whether the console sink should render the pretty formatter.
 *
 * With nothing said either way, the terminal decides: a person watching an
 * attached TTY gets the colourised layout, while a piped or redirected stream
 * (a container, a log shipper, a CI job) gets machine-readable JSON lines.
 */
function shouldFormatPretty(requested: "pretty" | "json" | undefined): boolean {
  const format = requested ?? process.env.LOG_FORMAT?.trim().toLowerCase();
  if (format === "pretty") {
    return true;
  }
  if (format === "json") {
    return false;
  }

  // @types/node calls this a boolean; Node leaves it undefined off a terminal.
  return process.stdout.isTTY;
}

function resolvePrettyProperties(): boolean {
  const configured = process.env.LOG_PRETTY_PROPERTIES?.trim().toLowerCase();
  if (!configured) {
    return true;
  }

  return !["0", "false", "no", "off"].includes(configured);
}

/**
 * How deep the pretty formatter walks a structured field.
 *
 * Three covers a record's own grouping (`run: { … }`) plus a nested value
 * inside it. Deeper than that is where a payload turns into a page of output,
 * which is the thing this format exists to avoid.
 */
function resolvePrettyInspectDepth(): number {
  const configured = process.env.LOG_PRETTY_INSPECT_DEPTH?.trim();
  if (!configured) {
    return 3;
  }

  const parsedDepth = Number.parseInt(configured, 10);
  if (Number.isNaN(parsedDepth) || parsedDepth < 1) {
    return 3;
  }

  return parsedDepth;
}

/**
 * The column a grouped field has to fit inside to stay on one line.
 *
 * A record groups its fields by subject, and the layout keeps a group on one
 * line while it fits. `pnpm run dev` runs the app under concurrently, which
 * hands the child a pipe rather than a terminal, so `columns` is undefined
 * there and the constant is what decides.
 */
function resolvePrettyWidth(): number {
  const configured = process.env.LOG_PRETTY_WIDTH?.trim();
  const parsedWidth = configured ? Number.parseInt(configured, 10) : Number.NaN;
  if (!Number.isNaN(parsedWidth) && parsedWidth > 0) {
    return parsedWidth;
  }

  return process.stdout.columns ?? 120;
}

/**
 * Whether the layout emits ANSI escapes. `NO_COLOR` is the one switch, and the
 * terminal is not consulted: the dev server's stdout is a pipe into
 * concurrently, which passes the escapes through to the terminal behind it.
 */
function resolvePrettyColors(): boolean {
  return !process.env.NO_COLOR;
}

function resolveLevel(requested: LogLevel | undefined): LogLevel {
  if (requested !== undefined && isLogLevel(requested)) {
    return requested;
  }

  return resolveLogLevel();
}

/**
 * Installs Workflow Graph's console logging.
 *
 * Call it once, before `createWfGraphApp`, from the host's own entry file.
 * Calling it again replaces the configuration rather than failing, so a process
 * that reconfigures on a reload is safe. It replaces any other logtape
 * configuration in the process, including a host's own.
 */
export function configureWfGraphLogging(
  options: WfGraphLoggingOptions = {}
): void {
  const prettyFormatter = createPrettyFormatter({
    colors: resolvePrettyColors(),
    properties: resolvePrettyProperties(),
    depth: resolvePrettyInspectDepth(),
    width: resolvePrettyWidth(),
  });

  configureSync({
    reset: true,
    sinks: {
      console: getConsoleSink({
        formatter: shouldFormatPretty(options.format)
          ? prettyFormatter
          : getJsonLinesFormatter({
              categorySeparator: ".",
              // Each field sits at the top level of the JSON object rather
              // than under a "properties" key, so a grouped field arrives as
              // `run` holding its members and a query names `run.execution`.
              properties: "flatten",
            }),
      }),
    },
    loggers: loggerConfigs("console", resolveLevel(options.level)),
  });
}
