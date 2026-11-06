/**
 * The CEL filter Inngest evaluates for an Event's `source.when`, rooted at
 * `event.data` because that is where Inngest carries the payload. It is built
 * and parsed when the Event is defined, so a bad path fails where it was written.
 */

import { parse as parseCel } from "@marcbachmann/cel-js";
import { compact } from "es-toolkit/array";
import { celStringLiteral } from "#src/conditions/cel-string-literal";

/** A path segment CEL reads as a plain field rather than as an expression. */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A source filter's path, as segments, refusing one that names no field. */
function sourceFilterSegments(path: string): string[] {
  const segments = compact(path.split(".").map((segment) => segment.trim()));

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
