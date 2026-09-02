/**
 * How this project turns a failed decode into a sentence a person reads.
 *
 * Effect keeps the rejected value out of its own messages unless a decode opts
 * in with `reportInput`, and no decode here does. What is left to bound is
 * length: a union that matched nothing renders as the full shape of every arm,
 * and a failure carrying many issues renders all of them. These strings are
 * persisted as run errors, written to the log, and answered over HTTP, so each
 * one names the field that was wrong and what was expected of it, then stops.
 *
 * An empty union match (AnyOf with no nested issues) reaches Effect's formatter
 * past `leafHook`, so it is rewritten into a leaf first;
 * `makeFormatterStandardSchemaV1` exposes no hook for that case.
 */

import { SchemaAST, SchemaIssue } from "effect";
import { uniq } from "es-toolkit/array";

/** The most issues one summary spells out before it starts counting. */
const MAX_LISTED_ISSUES = 3;

/**
 * Effect's Standard Schema formatter handles an empty AnyOf itself -- past
 * `leafHook` -- and names every arm of the union in full. Rewrite those nodes
 * into leaves the hook below describes by kind, before the formatter runs.
 * Nested issues under a union that matched nothing stay as they are; only the
 * no-match, no-nested-issues case is the hole.
 *
 * The annotated branch below restores a `message` annotation that Effect's own
 * empty-AnyOf handling would have honoured, because rewriting the node is what
 * loses it.
 */
function rewriteEmptyAnyOf(issue: SchemaIssue.Issue): SchemaIssue.Issue {
  if (issue instanceof SchemaIssue.AnyOf) {
    if (issue.issues.length === 0) {
      const annotated = issue.ast.annotations?.message;
      if (typeof annotated === "string") {
        return new SchemaIssue.InvalidValue({ message: annotated });
      }

      return new SchemaIssue.InvalidType(issue.ast);
    }

    return new SchemaIssue.AnyOf(
      issue.ast,
      issue.issues.map(rewriteEmptyAnyOf)
    );
  }

  if (issue instanceof SchemaIssue.Composite) {
    const [first, ...rest] = issue.issues.map(rewriteEmptyAnyOf);
    if (first === undefined) {
      return issue;
    }

    return new SchemaIssue.Composite(issue.ast, [first, ...rest]);
  }

  if (issue instanceof SchemaIssue.Pointer) {
    return new SchemaIssue.Pointer(issue.path, rewriteEmptyAnyOf(issue.issue));
  }

  if (issue instanceof SchemaIssue.Encoding) {
    return new SchemaIssue.Encoding(issue.ast, rewriteEmptyAnyOf(issue.issue));
  }

  if (issue instanceof SchemaIssue.Filter) {
    return new SchemaIssue.Filter(issue.filter, rewriteEmptyAnyOf(issue.issue));
  }

  return issue;
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

  if (SchemaAST.isUndefined(ast)) {
    return "undefined";
  }

  if (SchemaAST.isNull(ast)) {
    return "null";
  }

  if (SchemaAST.isArrays(ast)) {
    return "an array";
  }

  if (SchemaAST.isObjects(ast)) {
    return "an object";
  }

  if (SchemaAST.isUnion(ast)) {
    // A JSON codec rewrites `optional(X)` so the Undefined arm encodes as Null;
    // Effect's own expected label follows that link (`string | null`). Walk the
    // encoded form so a refused `undefined` still names what the wire allows.
    const annotated = ast.annotations?.expected;
    if (typeof annotated === "string") {
      return annotated;
    }

    return uniq(
      ast.types.map((type) => expectedTypeName(SchemaAST.toEncoded(type)))
    ).join(" | ");
  }

  return "a valid value";
}

/**
 * Every terminal issue as what was expected of the field, in one short phrase.
 *
 * This is the boundary that holds a rejected value out of a message. It reads
 * `issue.ast` and lets `issue.input` be, so a decode that does opt into
 * `reportInput` still renders the same sentence here. Effect's own label for a
 * composite type spells its whole shape out, and naming the kind keeps a message
 * as short as the failure is deep.
 *
 * The issue kinds are told apart by class rather than by their `_tag`, which
 * the repo's lint reserves.
 */
const boundedLeafHook: SchemaIssue.LeafHook = (issue) => {
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

// No `checkHook`, so a failed check keeps Effect's own sentence, which names the
// bound it wanted (`Expected a value with a length of at least 1`). Overriding it
// would flatten every check in the repo to one word, and `NonEmptyTrimmedString`
// alone stands behind half the contracts.
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: boundedLeafHook,
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
 * The whole failure in one line: `path: message` per issue, semicolon
 * separated, with a count standing in for whatever did not fit.
 *
 * Pair this with `errors: "all"` at the decode call. Stopping at the first
 * issue would make the count this prints always zero.
 */
export function formatSchemaFailure(issue: SchemaIssue.Issue): string {
  return summarize(formatIssues(rewriteEmptyAnyOf(issue)).issues);
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
