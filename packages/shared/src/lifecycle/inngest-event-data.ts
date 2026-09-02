/**
 * The `event.data.` form Inngest wants, from the schema-relative form an author
 * writes.
 *
 * Flow control is authored against the payload -- a `key` as a dot-path
 * (`"appointment.id"`), `priority.run` as a CEL expression over the payload's
 * top-level keys -- because that is the shape whoever declared the schema is
 * holding. Inngest reads neither: every path and identifier it evaluates is
 * rooted at `event.data`. Both surfaces that accept such options translate
 * through here, an Event in @wfgraph/core and a trigger in this package, and both do
 * it at definition so a bad path fails where it was written.
 */

import { parse as parseCel } from "@marcbachmann/cel-js";
import { celStringLiteral } from "#src/conditions/cel-string-literal";

function prefixEventDataPath(path: string): string {
  return `event.data.${path}`;
}

/** A path segment CEL reads as a plain field rather than as an expression. */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A source filter's path, as segments, refusing one that names no field. */
function sourceFilterSegments(path: string): string[] {
  const segments = path
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    throw new Error("A source filter needs a payload path to compare");
  }

  return segments;
}

/**
 * One payload path compared against one literal, as Inngest evaluates it.
 *
 * This is what `source.when` becomes: the filter on an Event's trigger, so an
 * umbrella bus is narrowed in Inngest's own layer and a subtype nothing declared
 * costs no invocation.
 *
 * The literal goes through `celStringLiteral`, and a segment that is not a plain
 * identifier is bracketed with the same literal, so a hyphenated key reads as a
 * field access rather than a subtraction. The whole expression is then parsed
 * here, at definition, so a value that produces something CEL cannot read fails
 * where it was written instead of at sync time.
 */
export function compileEventDataEquals(when: {
  readonly path: string;
  readonly equals: string;
}): string {
  const accessor = sourceFilterSegments(when.path)
    .map((segment) =>
      PLAIN_IDENTIFIER.test(segment)
        ? `.${segment}`
        : `[${celStringLiteral(segment)}]`
    )
    .join("");

  const expression = `event.data${accessor} == ${celStringLiteral(when.equals)}`;

  try {
    parseCel(expression);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `A source filter on "${when.path}" does not compile to a CEL expression: ${message}`,
      { cause: error }
    );
  }

  return expression;
}

/** One flow-control option with its partition key moved under `event.data`. */
export function prefixKeyField<T extends { key?: string | undefined }>(
  obj: T
): T {
  if (!obj.key) {
    return obj;
  }
  return { ...obj, key: prefixEventDataPath(obj.key) };
}

type CelAstNode = {
  readonly op: string;
  readonly args: unknown;
  readonly pos: number;
};

function isCelAstNode(value: unknown): value is CelAstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "op" in value &&
    "pos" in value &&
    typeof value.op === "string" &&
    typeof value.pos === "number"
  );
}

/**
 * CEL's comprehension macros, each of which binds a loop variable.
 *
 * cel-js parses `items.exists(i, i.x > 1)` as an `rcall` whose args are the
 * macro name, the receiver, and a body list beginning with the bound variable's
 * `id` node -- indistinguishable in the tree from a free variable. A receiver
 * method call parses the same way, so the name is what tells the two apart.
 */
const CEL_COMPREHENSION_MACROS = new Set([
  "all",
  "exists",
  "exists_one",
  "filter",
  "map",
]);

/** The `id` node a macro's args bind, when this node is one of those calls. */
function macroBoundVariable(node: CelAstNode): string | undefined {
  if (node.op !== "rcall" || !Array.isArray(node.args)) {
    return undefined;
  }

  const [name, , body] = node.args;
  if (typeof name !== "string" || !CEL_COMPREHENSION_MACROS.has(name)) {
    return undefined;
  }

  const iterVar = Array.isArray(body) ? body[0] : undefined;
  return isCelAstNode(iterVar) &&
    iterVar.op === "id" &&
    typeof iterVar.args === "string"
    ? iterVar.args
    : undefined;
}

/**
 * Every free identifier in the expression, with the position it starts at.
 *
 * A macro's loop variable and every reference to it are left out: it names a
 * list element rather than a payload field, so checking it against the schema
 * keys would refuse a valid expression and prefixing it would produce one
 * Inngest cannot evaluate.
 */
function collectCelIdentifiers(
  root: CelAstNode
): Array<{ name: string; pos: number }> {
  const results: Array<{ name: string; pos: number }> = [];

  function walk(value: unknown, bound: ReadonlySet<string>): void {
    if (!isCelAstNode(value)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item, bound);
        }
      }
      return;
    }

    if (value.op === "id" && typeof value.args === "string") {
      if (!bound.has(value.args)) {
        results.push({ name: value.args, pos: value.pos });
      }
      return;
    }

    const iterVar = macroBoundVariable(value);
    walk(value.args, iterVar ? new Set([...bound, iterVar]) : bound);
  }

  walk(root, new Set());
  return results;
}

/**
 * Rewrite a `priority.run` expression's identifiers to their `event.data.` form,
 * holding each to `schemaKeys` first.
 *
 * The rewrite is textual over positions the parser reports, so the expression a
 * person wrote is what comes back, prefixes aside. `schemaKeys` of `undefined`
 * means the schema library published no field names, and the identifiers then go
 * unchecked rather than being refused for a fact nothing established.
 */
export function rewriteCelExpression(
  expression: string,
  schemaKeys: string[] | undefined
): string {
  let ast: CelAstNode;
  try {
    const parsed = parseCel(expression);
    ast = parsed.ast;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid CEL expression in priority.run: ${message}`, {
      cause: error,
    });
  }

  const identifiers = collectCelIdentifiers(ast);

  if (identifiers.length === 0) {
    return expression;
  }

  if (schemaKeys) {
    const keySet = new Set(schemaKeys);
    for (const id of identifiers) {
      if (!keySet.has(id.name)) {
        throw new Error(
          `Invalid identifier "${id.name}" in priority.run CEL expression, which must be a top-level schema key: ${schemaKeys.join(", ")}`
        );
      }
    }
  }

  // Rightmost first, so an earlier insertion cannot move a later position.
  const sorted = identifiers.toSorted((a, b) => b.pos - a.pos);

  let result = expression;
  for (const { pos } of sorted) {
    result = `${result.slice(0, pos)}event.data.${result.slice(pos)}`;
  }

  return result;
}
