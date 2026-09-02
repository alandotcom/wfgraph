/**
 * The console layout a person reads: one flush-left header line per record,
 * with the record's structured fields stacked below it as a small tree.
 *
 * Only `src/logging.ts` may import this module. It reaches `node:util` for
 * `inspect`, and the Worker bundle must not carry that.
 */

import type { LogLevel, LogRecord, TextFormatter } from "@logtape/logtape";
import { isPlainObject } from "es-toolkit/predicate";
import { inspect } from "node:util";
import { renderLogMessage } from "#src/backend/lib/log-config";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";

/** One colour per level, which is what a reader scans the left edge for. */
const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: "\x1b[90m",
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warning: "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[35m",
};

/** logtape spells the middle level `warning`; five characters is the ceiling. */
const LEVEL_LABELS: Record<LogLevel, string> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO",
  warning: "WARN",
  error: "ERROR",
  fatal: "FATAL",
};

/** Two spaces, then a three-character connector, puts a key at column 5. */
const FIELD_INDENT = "  ";
const BRANCH = "├─ ";
const LAST_BRANCH = "└─ ";
/** What a child row sits behind: the bar while siblings follow, blank after. */
const CHILD_BAR = "│  ";
const CHILD_BLANK = "   ";

export type PrettyFormatOptions = {
  /** Emit ANSI escapes. `NO_COLOR` is what turns this off. */
  colors: boolean;
  /** Render the structured fields under the header. */
  properties: boolean;
  /** How deep the layout walks a field before it hands the rest to `inspect`. */
  depth: number;
  /** The column a group has to fit inside to stay on one line. */
  width: number;
};

function paint(text: string, code: string, colors: boolean): string {
  return colors ? `${code}${text}${RESET}` : text;
}

/** Local wall-clock time, which is what a person watching a terminal reads. */
function formatTime(timestamp: number): string {
  const at = new Date(timestamp);
  const hours = String(at.getHours()).padStart(2, "0");
  const minutes = String(at.getMinutes()).padStart(2, "0");
  const seconds = String(at.getSeconds()).padStart(2, "0");
  const millis = String(at.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

/**
 * One physical line for tree connectors and inline width. A raw string or an
 * `inspect` answer can carry newlines (notably an `Error` stack).
 */
function singleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * One field value as text. A string prints bare, because the quotes `inspect`
 * adds are noise on a value the reader already knows is a string. Anything the
 * layout does not open itself goes through `inspect` with colours off, so a
 * line's measured width is also its printed width.
 */
function formatValue(value: unknown, depth: number): string {
  if (typeof value === "string") {
    return singleLine(value);
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  return singleLine(
    inspect(value, {
      depth: Math.max(0, depth),
      compact: true,
      breakLength: Infinity,
      colors: false,
    })
  );
}

/**
 * Whether a value is a group: a record's own subject grouping (`http`, `run`,
 * `error`), which the layout opens rather than inspecting whole. An empty
 * object carries nothing to open, so it stays a value.
 */
function isGroup(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

/**
 * A group on one line, as the `key=value` pairs evlog prints.
 *
 * A member that is itself an object is inspected rather than flattened again.
 * A second round of `key=value` inside the first would read as `input=id=abc`,
 * where the two levels of nesting are no longer told apart.
 */
function inlineGroup(group: Record<string, unknown>, depth: number): string {
  return Object.entries(group)
    .map(([key, value]) => `${key}=${formatValue(value, depth)}`)
    .join(" ");
}

/**
 * A value in a position that has a whole line to itself. A group flattens into
 * its pairs there, because the line's own key already names what they belong
 * to.
 */
function openValue(value: unknown, depth: number): string {
  return isGroup(value)
    ? inlineGroup(value, Math.max(0, depth - 1))
    : formatValue(value, depth);
}

/**
 * The rows for one top-level field. A group stays on one line while it fits
 * `width`, and opens into a row per member when it does not.
 */
function fieldLines(
  key: string,
  value: unknown,
  isLast: boolean,
  options: PrettyFormatOptions
): string[] {
  const connector = paint(isLast ? LAST_BRANCH : BRANCH, DIM, options.colors);
  const label = paint(`${key}:`, CYAN, options.colors);
  const head = `${FIELD_INDENT}${connector}${label}`;
  // The tree spends one level on the field and one on a group's member, so
  // whatever sits deeper than that is inspect's to walk.
  const memberDepth = Math.max(0, options.depth - 2);

  if (!isGroup(value)) {
    return [`${head} ${formatValue(value, options.depth - 1)}`];
  }

  const inline = inlineGroup(value, memberDepth);
  // Measured without the escapes: the visible line is the indent, the
  // connector, "key:", one space, and the pairs.
  const inlineWidth =
    FIELD_INDENT.length + BRANCH.length + key.length + 2 + inline.length;
  if (inlineWidth <= options.width) {
    return [`${head} ${inline}`];
  }

  // A bar is drawn and takes the dim colour. Blank space needs no escapes.
  const childIndent = isLast
    ? `${FIELD_INDENT}${CHILD_BLANK}`
    : `${FIELD_INDENT}${paint(CHILD_BAR, DIM, options.colors)}`;
  const members = Object.entries(value);
  return [
    head,
    ...members.map(([memberKey, memberValue], index) => {
      const childConnector = paint(
        index === members.length - 1 ? LAST_BRANCH : BRANCH,
        DIM,
        options.colors
      );
      const childLabel = paint(`${memberKey}:`, CYAN, options.colors);
      const childValue = openValue(memberValue, memberDepth);
      return `${childIndent}${childConnector}${childLabel} ${childValue}`;
    }),
  ];
}

/**
 * Builds the formatter `getConsoleSink` renders with.
 *
 * The console sink strips one trailing newline and calls `console.*`, so the
 * string returned here carries no newline of its own.
 */
export function createPrettyFormatter(
  options: PrettyFormatOptions
): TextFormatter {
  return (record: LogRecord): string => {
    const timestamp = paint(formatTime(record.timestamp), DIM, options.colors);
    const level = paint(
      LEVEL_LABELS[record.level],
      LEVEL_COLORS[record.level],
      options.colors
    );
    const category = paint(record.category.join("."), DIM, options.colors);
    const header = `${timestamp} ${level} ${category} ${renderLogMessage(
      record.message
    )}`;

    if (!options.properties) {
      return header;
    }

    const fields = Object.entries(record.properties);
    if (fields.length === 0) {
      return header;
    }

    const lines = fields.flatMap(([key, value], index) =>
      fieldLines(key, value, index === fields.length - 1, options)
    );
    return [header, ...lines].join("\n");
  };
}
