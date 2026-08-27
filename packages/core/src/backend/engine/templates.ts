/**
 * Replacing the `{{@nodeId:Label.field}}` references in a node's config with the
 * values the nodes upstream of it left behind.
 */

import {
  parseTemplate,
  resolveOutputPath,
  type TemplateToken,
} from "@wfgraph/shared/graph/node-references";
import type { NodeOutputs } from "#src/backend/engine/contracts";
import { outputKey } from "#src/backend/engine/traversal";

/**
 * Render a resolved value back into the surrounding template string. Objects and
 * arrays become JSON so a whole node output can be dropped into a text field.
 * A missing value renders as empty text, which is what an upstream node that was
 * disabled or that failed to produce the field leaves behind.
 */
function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `${value}`;
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  return "";
}

function resolveTemplateToken(
  token: TemplateToken,
  outputs: NodeOutputs
): string {
  const output = outputs[outputKey(token.nodeId)];
  if (!output) {
    // The token names a node that has not run, so the authored text stays put.
    return token.raw;
  }

  return stringifyTemplateValue(
    resolveOutputPath(output.data, token.fieldPath)
  );
}

/**
 * Replace every `{{@nodeId:Label.field}}` reference in the config's string values
 * with the upstream value it names.
 *
 * Both the grammar and the path walking come from `node-references`, the module
 * the editor's autocomplete builds its suggestions with, so a path it offers
 * (`items[0].name`, say) resolves to the same value here at run time.
 *
 * A key holding `undefined` is dropped rather than carried, because a step decodes
 * its config through its schema's canonical JSON codec, where an optional field
 * takes an absent key or a null and refuses one present and empty. A builder left
 * the field blank either way.
 *
 * `literalKeys` are the keys the action declared `literal`, whose values pass
 * through as they were authored.
 *
 * `templateObjectKeys` are the keys holding a JSON object of authored values.
 * Those resolve one value at a time, because substituting into the whole string
 * lets a resolved `"` or newline break the JSON and cost the step every value in
 * it rather than one.
 */
export function processTemplates(
  config: Record<string, unknown>,
  outputs: NodeOutputs,
  literalKeys: ReadonlySet<string>,
  templateObjectKeys: ReadonlySet<string> = new Set()
): Record<string, unknown> {
  const processed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) {
      continue;
    }

    processed[key] = resolveConfigValue({
      value,
      outputs,
      literal: literalKeys.has(key),
      asTemplateObject: templateObjectKeys.has(key),
    });
  }

  return processed;
}

function resolveConfigValue(input: {
  value: unknown;
  outputs: NodeOutputs;
  literal: boolean;
  asTemplateObject: boolean;
}): unknown {
  const { value, outputs, literal, asTemplateObject } = input;
  if (typeof value !== "string" || literal) {
    return value;
  }

  return asTemplateObject
    ? resolveTemplateObjectString(value, outputs)
    : resolveTemplateString(value, outputs);
}

/**
 * Resolve each value of a JSON object of authored templates, and re-serialise.
 *
 * Text that is not such an object falls back to resolving the whole string.
 * That is the escape hatch a builder gets when the provider-backed form cannot
 * draw, so the value they typed by hand keeps behaving as it always did.
 */
function resolveTemplateObjectString(
  value: string,
  outputs: NodeOutputs
): string {
  const entries = readTemplateObject(value);
  if (!entries) {
    return resolveTemplateString(value, outputs);
  }

  const resolved: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(entries)) {
    resolved[key] =
      typeof entry === "string" ? resolveTemplateString(entry, outputs) : entry;
  }

  // `JSON.stringify` is what escapes a resolved quotation mark or newline, and
  // doing it here rather than in the step is what keeps the boundary a string.
  return JSON.stringify(resolved);
}

/** The object of scalars this text holds, or nothing when it holds something else. */
function readTemplateObject(
  value: string
): Record<string, string | number> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const entries: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== "string" && typeof entry !== "number") {
      return null;
    }
    entries[key] = entry;
  }
  return entries;
}

/** One authored string with its references replaced. */
export function resolveTemplateString(
  value: string,
  outputs: NodeOutputs
): string {
  return parseTemplate(value)
    .map((segment) =>
      segment.kind === "literal"
        ? segment.text
        : resolveTemplateToken(segment.token, outputs)
    )
    .join("");
}
