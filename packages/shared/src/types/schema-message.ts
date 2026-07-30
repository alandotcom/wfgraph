/**
 * How this project turns a failed decode into a sentence a person reads.
 *
 * Effect's own renderer prints the value that failed, in full. That is the
 * right default for a schema over values a program produced, and the wrong one
 * everywhere this project decodes: a step output arrives from an HTTP response
 * nobody controls, a route parameter arrives from a URL anyone can type, and
 * the message built from either is persisted as a run error, written to the
 * log, and handed back over HTTP. One bad response is enough to carry a body of
 * addresses and tokens into all three.
 *
 * So every message here is bounded. An object or an array is named by its kind,
 * a primitive is cut short, and a failure with many issues shows the first few
 * and counts the rest. What the reader needs is which field was wrong and what
 * was expected of it, and neither of those is the value itself.
 */

import { Option, SchemaAST, SchemaIssue } from "effect";

/** The longest run of a rejected value a message may quote, in characters. */
const MAX_QUOTED_LENGTH = 20;

/** The most issues one summary spells out before it starts counting. */
const MAX_LISTED_ISSUES = 3;

function truncate(text: string): string {
  return text.length <= MAX_QUOTED_LENGTH
    ? text
    : `${text.slice(0, MAX_QUOTED_LENGTH)}...`;
}

/** How a message names the value it rejected. */
function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(truncate(value));
  }

  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return truncate(String(value));
  }

  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "symbol") {
    return truncate(value.toString());
  }

  if (Array.isArray(value)) {
    return "an array";
  }

  if (typeof value === "function") {
    return "a function";
  }

  return "an object";
}

function describeMissingOrValue(actual: Option.Option<unknown>): string {
  return Option.isNone(actual) ? "no value" : describeValue(actual.value);
}

/** What a message calls the type a schema node asked for. */
function expectedTypeName(ast: SchemaAST.AST): string {
  if (SchemaAST.isString(ast)) {
    return "string";
  }

  if (SchemaAST.isNumber(ast)) {
    return "number";
  }

  if (SchemaAST.isBoolean(ast)) {
    return "boolean";
  }

  if (SchemaAST.isArrays(ast)) {
    return "an array";
  }

  if (SchemaAST.isObjects(ast)) {
    return "an object";
  }

  return "a valid value";
}

/**
 * Every terminal issue, rendered without the value that caused it.
 *
 * The issue kinds are told apart by class rather than by their `_tag`, which
 * the repo's lint reserves.
 */
const boundedLeafHook: SchemaIssue.LeafHook = (issue) => {
  if (issue instanceof SchemaIssue.InvalidType) {
    return `Expected ${expectedTypeName(issue.ast)}, got ${describeMissingOrValue(issue.actual)}`;
  }

  if (issue instanceof SchemaIssue.MissingKey) {
    return issue.annotations?.messageMissingKey ?? "Missing key";
  }

  if (issue instanceof SchemaIssue.UnexpectedKey) {
    return `Unexpected key holding ${describeValue(issue.actual)}`;
  }

  if (issue instanceof SchemaIssue.OneOf) {
    return `Expected exactly one match, got ${describeValue(issue.actual)}`;
  }

  return (
    issue.annotations?.message ??
    `Invalid value, got ${describeMissingOrValue(issue.actual)}`
  );
};

/**
 * A check that failed without saying why falls back to Effect's own text, which
 * quotes the value, so the fallback is written here instead. A check that
 * reported something other than a plain rejection is passed on, so its own
 * issues keep their paths.
 */
const boundedCheckHook: SchemaIssue.CheckHook = (issue) => {
  const annotated = SchemaIssue.defaultCheckHook(issue);
  if (annotated !== undefined) {
    return annotated;
  }

  return issue.issue instanceof SchemaIssue.InvalidValue
    ? `Invalid value, got ${describeValue(issue.actual)}`
    : undefined;
};

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: boundedLeafHook,
  checkHook: boundedCheckHook,
});

type FormattedIssue = ReturnType<typeof formatIssues>["issues"][number];

function formatIssuePath(issue: FormattedIssue): string {
  return formatStandardIssuePath(issue.path);
}

/**
 * A Standard Schema issue's path as a dot-path, `<root>` when it names none.
 *
 * Exported because a foreign library's issues arrive in the same shape and get
 * rendered the same way: an Event payload written in Zod is refused with the paths
 * this builds.
 */
export function formatStandardIssuePath(
  segments: FormattedIssue["path"]
): string {
  let path = "";
  for (const segment of segments ?? []) {
    const key = typeof segment === "object" ? segment.key : segment;

    if (typeof key === "number") {
      path += `[${key}]`;
      continue;
    }

    if (!path) {
      path = String(key);
      continue;
    }

    path += `.${String(key)}`;
  }

  return path || "<root>";
}

/**
 * Every terminal issue as what was expected, with nothing of what arrived.
 *
 * The hook above cuts a rejected value down; this one leaves it out. An Event's
 * payload is a host's own message -- a phone number, an address, an amount -- and
 * a refusal built from it is answered to a third-party sender across origins and
 * written to the log. What places the fault is the path and the expectation, and
 * the sender holds the schema.
 */
const pathsOnlyLeafHook: SchemaIssue.LeafHook = (issue) => {
  if (issue instanceof SchemaIssue.InvalidType) {
    return `Expected ${expectedTypeName(issue.ast)}`;
  }

  if (issue instanceof SchemaIssue.MissingKey) {
    return issue.annotations?.messageMissingKey ?? "Missing key";
  }

  if (issue instanceof SchemaIssue.UnexpectedKey) {
    return "Unexpected key";
  }

  if (issue instanceof SchemaIssue.OneOf) {
    return "Expected exactly one match";
  }

  return issue.annotations?.message ?? "Invalid value";
};

const formatIssuePaths = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: pathsOnlyLeafHook,
  checkHook: (issue) => SchemaIssue.defaultCheckHook(issue) ?? "Invalid value",
});

/**
 * The whole failure in one line: `path: message` per issue, semicolon
 * separated, with a count standing in for whatever did not fit.
 *
 * Pair this with `errors: "all"` at the decode call. Stopping at the first
 * issue would make the count this prints always zero.
 */
export function formatSchemaFailure(issue: SchemaIssue.Issue): string {
  return summarize(formatIssues(issue).issues);
}

/**
 * The same summary with the values left out entirely.
 *
 * For a refusal that travels to whoever sent the value: an Event payload at
 * intake, where the sender is a third party and the string is answered across
 * origins.
 */
export function formatSchemaFailurePaths(issue: SchemaIssue.Issue): string {
  return summarize(formatIssuePaths(issue).issues);
}

function summarize(issues: readonly FormattedIssue[]): string {
  const displayedIssues = issues.slice(0, MAX_LISTED_ISSUES);
  const summary = displayedIssues
    .map((formatted) => `${formatIssuePath(formatted)}: ${formatted.message}`)
    .join("; ");

  if (issues.length <= displayedIssues.length) {
    return summary;
  }

  return `${summary}; ... (+${issues.length - displayedIssues.length} more)`;
}
