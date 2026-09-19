import { mapValues } from "es-toolkit/object";
import {
  templateReferencesInString,
  type ConfigTemplateReference,
} from "#src/graph/node-references";
import type { TemplateJsonShape } from "#src/plugins/action-fields";
import { readKeyValueRows } from "#src/plugins/key-value-rows";
import { readProviderFieldValues } from "#src/plugins/provider-field-values";

/** One config string the action runtime actually interpolates. */
export type ConsumedTemplateString = {
  /** Exact top-level config key whose value holds this string. */
  configKey: string;
  /** Dotted config location used in validation messages. */
  field: string;
  value: string;
};

const BUILT_IN_LITERAL_KEYS = new Set([
  "actionType",
  "condition",
  "conditionModel",
]);

/** Rules that distinguish templates from literal or inactive config values. */
export type TemplateConfigRules = {
  literalKeys: ReadonlySet<string>;
  jsonShapes: ReadonlyMap<string, TemplateJsonShape>;
  /** Present for shape-dependent actions such as Wait. */
  activeKeys?: ReadonlySet<string> | undefined;
};

/**
 * Transform each string an action consumes as a template.
 *
 * JSON-backed fields are decoded before visiting their values so token parsing
 * sees the same authored text as execution. A malformed JSON-backed value falls
 * back to one ordinary template string, matching the runtime's recovery path.
 */
export function mapTemplateConfigStrings(
  config: Readonly<Record<string, unknown>>,
  rules: TemplateConfigRules,
  transform: (input: ConsumedTemplateString) => string
): Record<string, unknown> {
  const processed: Array<[string, unknown]> = [];

  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) {
      continue;
    }

    processed.push([
      key,
      mapConfigValue({
        configKey: key,
        field: key,
        value,
        active: rules.activeKeys?.has(key) ?? true,
        literal: rules.literalKeys.has(key) || BUILT_IN_LITERAL_KEYS.has(key),
        jsonShape: rules.jsonShapes.get(key),
        transform,
      }),
    ]);
  }

  return Object.fromEntries(processed);
}

function mapConfigValue(input: {
  configKey: string;
  field: string;
  value: unknown;
  active: boolean;
  literal: boolean;
  jsonShape: TemplateJsonShape | undefined;
  transform: (input: ConsumedTemplateString) => string;
}): unknown {
  const { configKey, field, value, active, literal, jsonShape, transform } =
    input;
  if (!active || literal || typeof value !== "string") {
    return value;
  }

  if (jsonShape === "key-value") {
    const rows = readKeyValueRows(value);
    return rows
      ? JSON.stringify(
          rows.map((row, index) => ({
            name: row.name,
            value: transform({
              configKey,
              field: `${field}.${index}.value`,
              value: row.value,
            }),
          }))
        )
      : transform({ configKey, field, value });
  }

  if (jsonShape === "provider-fields") {
    const entries = readProviderFieldValues(value);
    return entries
      ? JSON.stringify(
          mapValues(entries, (entry, key) =>
            typeof entry === "string"
              ? transform({
                  configKey,
                  field: `${field}.${key}`,
                  value: entry,
                })
              : entry
          )
        )
      : transform({ configKey, field, value });
  }

  return transform({ configKey, field, value });
}

/** Every string the action runtime consumes as a template, before resolution. */
export function templateStringsInConfig(
  config: Readonly<Record<string, unknown>>,
  rules: TemplateConfigRules
): ConsumedTemplateString[] {
  const strings: ConsumedTemplateString[] = [];
  mapTemplateConfigStrings(config, rules, (input) => {
    strings.push(input);
    return input.value;
  });
  return strings;
}

/** References from the exact config strings execution will interpolate. */
export function extractConsumedTemplateReferences(
  config: Readonly<Record<string, unknown>>,
  rules: TemplateConfigRules,
  additionalStrings: readonly ConsumedTemplateString[] = []
): ConfigTemplateReference[] {
  return [
    ...templateStringsInConfig(config, rules),
    ...additionalStrings,
  ].flatMap(({ configKey, field, value }) =>
    templateReferencesInString(value, field, configKey)
  );
}
