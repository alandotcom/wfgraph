import { mapValues } from "es-toolkit/object";
import { ACTION_TYPE_CONFIG_KEY } from "#src/graph/node-config";
import {
  templateReferencesInString,
  type ConfigTemplateReference,
} from "#src/graph/node-references";
import {
  type ActionConfigField,
  literalFieldKeys,
  type TemplateJsonShape,
  templateJsonFieldShapes,
} from "#src/plugins/action-fields";
import {
  type KeyValueRow,
  readKeyValueRows,
} from "#src/plugins/key-value-rows";
import {
  type ProviderFieldValues,
  readProviderFieldValues,
} from "#src/plugins/provider-field-values";

/** One config string the action runtime actually interpolates. */
export type ConsumedTemplateString = {
  /** Exact top-level config key whose value holds this string. */
  configKey: string;
  /** Dotted config location used in validation messages. */
  field: string;
  value: string;
};

const BUILT_IN_LITERAL_KEYS = new Set([
  ACTION_TYPE_CONFIG_KEY,
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
 * The rules for a node whose action declares `configFields`: its `literal`
 * keys and its JSON-backed keys, groups flattened. `activeKeys` is for a Wait,
 * whose current shape reads only some of its keys.
 */
export function templateConfigRules(
  configFields: readonly ActionConfigField[],
  activeKeys?: ReadonlySet<string>
): TemplateConfigRules {
  return {
    literalKeys: new Set(literalFieldKeys(configFields)),
    jsonShapes: new Map(templateJsonFieldShapes(configFields)),
    activeKeys,
  };
}

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

    processed.push([key, mapConfigValue(key, value, rules, transform)]);
  }

  return Object.fromEntries(processed);
}

/** How the action runtime reads one stored config value. */
export type ConfigValueReading =
  /** Handed to the step as stored, with no reference resolved in it. */
  | { kind: "stored" }
  /** One template string, resolved as a whole. */
  | { kind: "template"; text: string }
  /** `key-value` rows: each row's value is a template, its name is not. */
  | { kind: "key-value"; rows: KeyValueRow[] }
  /** `provider-fields` entries: each string entry is a template. */
  | { kind: "provider-fields"; entries: ProviderFieldValues };

/**
 * The reading of the value under the top-level config key `key`. A value under
 * an inactive or literal key, or one that is not a string, is `stored`. A
 * JSON-backed string its shape's reader refuses is one `template`.
 */
export function readConfigValue(
  key: string,
  value: unknown,
  rules: TemplateConfigRules
): ConfigValueReading {
  const active = rules.activeKeys?.has(key) ?? true;
  const literal = rules.literalKeys.has(key) || BUILT_IN_LITERAL_KEYS.has(key);
  if (!active || literal || typeof value !== "string") {
    return { kind: "stored" };
  }

  const jsonShape = rules.jsonShapes.get(key);
  if (jsonShape === "key-value") {
    const rows = readKeyValueRows(value);
    if (rows) {
      return { kind: "key-value", rows };
    }
  }
  if (jsonShape === "provider-fields") {
    const entries = readProviderFieldValues(value);
    if (entries) {
      return { kind: "provider-fields", entries };
    }
  }
  return { kind: "template", text: value };
}

/** One config value with each template string in it transformed. */
function mapConfigValue(
  configKey: string,
  value: unknown,
  rules: TemplateConfigRules,
  transform: (input: ConsumedTemplateString) => string
): unknown {
  const reading = readConfigValue(configKey, value, rules);
  if (reading.kind === "stored") {
    return value;
  }
  if (reading.kind === "template") {
    return transform({ configKey, field: configKey, value: reading.text });
  }
  if (reading.kind === "key-value") {
    return JSON.stringify(
      reading.rows.map((row, index) => ({
        name: row.name,
        value: transform({
          configKey,
          field: `${configKey}.${index}.value`,
          value: row.value,
        }),
      }))
    );
  }
  return JSON.stringify(
    mapValues(reading.entries, (entry, entryKey) =>
      typeof entry === "string"
        ? transform({
            configKey,
            field: `${configKey}.${entryKey}`,
            value: entry,
          })
        : entry
    )
  );
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
