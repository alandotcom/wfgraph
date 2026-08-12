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
import { getPrettyFormatter } from "@logtape/pretty";
import { loggerConfigs, resolveLogLevel } from "#src/backend/lib/log-config";

export type WfGraphLoggingOptions = {
  /** Lowest level the `wfgraph` category records. `LOG_LEVEL`, else `info`. */
  level?: LogLevel;
  /**
   * `pretty` for the colourised layout a person reads, `json` for one JSON
   * object per line. `LOG_FORMAT` decides when this is unset, and the terminal
   * decides when that is unset too.
   */
  format?: "pretty" | "json";
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

type PrettyInspectOptions = NonNullable<
  Parameters<typeof getPrettyFormatter>[0]
>["inspectOptions"];

/**
 * How the pretty formatter renders one structured field.
 *
 * A record groups its fields into one object per subject, so the formatter
 * prints a line per group rather than a line per field. That only holds while a
 * group fits on one line, which is what `breakLength` decides. The formatter
 * spreads these into Node's `util.inspect`, which reads the option, while its
 * own option type lists five keys and not that one. `Object.assign` builds the
 * value rather than writing it inline, because an object literal would be
 * refused for the sixth key.
 */
function prettyInspectOptions(depth: number): PrettyInspectOptions {
  return Object.assign({ depth, compact: true }, { breakLength: 200 });
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
  const prettyFormatter = getPrettyFormatter({
    timestamp: "time",
    categorySeparator: ".",
    icons: false,
    align: true,
    // The longest category in the tree is wfgraph.global-executions. Every line
    // pays this width, which is why the categories are one level deep.
    categoryWidth: 25,
    properties: resolvePrettyProperties(),
    inspectOptions: prettyInspectOptions(resolvePrettyInspectDepth()),
    wordWrap: false,
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
