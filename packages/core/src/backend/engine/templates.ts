/**
 * Replacing the `{{@nodeId:Label.field}}` references in a node's config with the
 * values the nodes upstream of it left behind.
 */

import {
  parseTemplate,
  resolveOutputPath,
  type TemplateToken,
} from "@wfgraph/shared/graph/node-references";
import type { TemplateJsonShape } from "@wfgraph/shared/plugins/action-fields";
import { readKeyValueRows } from "@wfgraph/shared/plugins/key-value-rows";
import { readProviderFieldValues } from "@wfgraph/shared/plugins/provider-field-values";
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
 * `jsonShapes` names the keys whose text is JSON holding authored values, and
 * which layout each is in. Those resolve one value at a time, because
 * substituting into the whole string lets a resolved `"` or newline break the
 * JSON and cost the step every value in it rather than one.
 */
export function processTemplates(
  config: Record<string, unknown>,
  outputs: NodeOutputs,
  literalKeys: ReadonlySet<string>,
  jsonShapes: ReadonlyMap<string, TemplateJsonShape> = new Map()
): Record<string, unknown> {
  const processed: Array<[string, unknown]> = [];

  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) {
      continue;
    }

    processed.push([
      key,
      resolveConfigValue({
        value,
        outputs,
        literal: literalKeys.has(key),
        jsonShape: jsonShapes.get(key),
      }),
    ]);
  }

  return Object.fromEntries(processed);
}

function resolveConfigValue(input: {
  value: unknown;
  outputs: NodeOutputs;
  literal: boolean;
  jsonShape: TemplateJsonShape | undefined;
}): unknown {
  const { value, outputs, literal, jsonShape } = input;
  if (typeof value !== "string" || literal) {
    return value;
  }

  if (!jsonShape) {
    return resolveTemplateString(value, outputs);
  }

  return jsonShape === "key-value"
    ? resolveKeyValueRows(value, outputs)
    : resolveProviderFields(value, outputs);
}

/**
 * Resolve each row's value in a `key-value` field, and re-serialise.
 *
 * A row list stays a list because a row is a row: two rows may carry the same
 * name, and the order is the one they were added in.
 *
 * A row's name is left as authored. It is the key of whatever the step is
 * building, and the systems that take one hold it to a short constrained
 * alphabet, so a reference resolved into it would name a key nobody could match.
 *
 * Text this cannot read falls back to resolving the whole string, which is the
 * escape hatch a builder gets when the widget cannot draw: what they typed by
 * hand keeps behaving as it always did.
 */
function resolveKeyValueRows(value: string, outputs: NodeOutputs): string {
  const rows = readKeyValueRows(value);
  if (!rows) {
    return resolveTemplateString(value, outputs);
  }

  // `JSON.stringify` is what escapes a resolved quotation mark or newline, and
  // doing it here rather than in the step is what keeps the boundary a string.
  return JSON.stringify(
    rows.map((row) => ({
      name: row.name,
      value: resolveTemplateString(row.value, outputs),
    }))
  );
}

/**
 * Resolve each value of a `provider-fields` object, and re-serialise.
 *
 * One object keyed by the variable each value fills. A number stays a number:
 * the panel stores a variable the provider declared numeric as a JSON number,
 * and only the strings hold templates.
 */
function resolveProviderFields(value: string, outputs: NodeOutputs): string {
  const entries = readProviderFieldValues(value);
  if (!entries) {
    return resolveTemplateString(value, outputs);
  }

  const resolved: Array<[string, string | number]> = [];
  for (const [key, entry] of Object.entries(entries)) {
    resolved.push([
      key,
      typeof entry === "string" ? resolveTemplateString(entry, outputs) : entry,
    ]);
  }

  return JSON.stringify(Object.fromEntries(resolved));
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
