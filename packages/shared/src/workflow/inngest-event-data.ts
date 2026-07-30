/**
 * The `event.data.` form Inngest wants, from the schema-relative form an author
 * writes.
 *
 * Flow control is authored against the payload -- a `key` as a dot-path
 * (`"appointment.id"`), `priority.run` as a CEL expression over the payload's
 * top-level keys -- because that is the shape whoever declared the schema is
 * holding. Inngest reads neither: every path and identifier it evaluates is
 * rooted at `event.data`. Both surfaces that accept such options translate
 * through here, an Event in @rova/core and a trigger in this package, and both do
 * it at definition so a bad path fails where it was written.
 */

import { parse as parseCel } from "@marcbachmann/cel-js";

function prefixEventDataPath(path: string): string {
  return `event.data.${path}`;
}

/** One flow-control option with its partition key moved under `event.data`. */
export function prefixKeyField<T extends { key?: string }>(obj: T): T {
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

function collectCelIdentifiers(
  root: CelAstNode
): Array<{ name: string; pos: number }> {
  const results: Array<{ name: string; pos: number }> = [];

  function walk(value: unknown): void {
    if (!isCelAstNode(value)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item);
        }
      }
      return;
    }

    if (value.op === "id" && typeof value.args === "string") {
      results.push({ name: value.args, pos: value.pos });
      return;
    }

    walk(value.args);
  }

  walk(root);
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
          `Invalid identifier "${id.name}" in priority.run CEL expression — must be a top-level schema key (${schemaKeys.join(", ")})`
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
