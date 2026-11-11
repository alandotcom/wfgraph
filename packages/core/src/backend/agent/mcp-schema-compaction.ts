/**
 * Shrinks the JSON Schemas the MCP endpoint lists, which a client sends to its
 * model on every turn, without changing what any schema accepts. The toolkit's
 * own schemas are left as they are, since the built-in agent reads them through
 * its model provider rather than through this listing.
 */

import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "@wfgraph/shared/types/json";

/** A subtree shorter than this, as JSON, stays inline wherever it repeats. */
const MIN_SHARED_CHARS = 100;

/** The keywords whose value is a map from names to subschemas. */
const SCHEMA_MAPS = new Set(["properties", "$defs"]);

/** The keywords whose value is a subschema or a list of subschemas. */
const SCHEMA_SLOTS = new Set([
  "items",
  "additionalProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
]);

/**
 * Rebuilds a schema bottom-up, handing each subschema to `visit` after its own
 * subschemas were rebuilt. Only keyword positions that hold subschemas are
 * walked, so a property map or an `enum` value is never mistaken for a schema.
 */
function mapSchemas(
  schema: JsonValue,
  visit: (schema: JsonObject) => JsonValue
): JsonValue {
  if (!isJsonObject(schema)) {
    return schema;
  }
  const rebuilt: JsonObject = {};
  for (const [key, item] of Object.entries(schema)) {
    if (SCHEMA_MAPS.has(key) && isJsonObject(item)) {
      const map: JsonObject = {};
      for (const [name, child] of Object.entries(item)) {
        map[name] = mapSchemas(child, visit);
      }
      rebuilt[key] = map;
    } else if (SCHEMA_SLOTS.has(key)) {
      rebuilt[key] = Array.isArray(item)
        ? item.map((child) => mapSchemas(child, visit))
        : mapSchemas(item, visit);
    } else {
      rebuilt[key] = item;
    }
  }
  return visit(rebuilt);
}

/**
 * Drops `additionalProperties: true`, which is the JSON Schema default and
 * which Effect writes on every nested object.
 */
function withoutDefaultKeys(schema: JsonValue): JsonValue {
  return mapSchemas(schema, (node) => {
    if (node.additionalProperties !== true) {
      return node;
    }
    const { additionalProperties: _default, ...kept } = node;
    return kept;
  });
}

/**
 * Counts each subschema below `schema` as JSON text, with the property name it
 * first sat under, which names it if it is moved into `$defs`.
 */
function countSubschemas(
  schema: JsonValue,
  name: string,
  found: Map<string, { count: number; name: string }>
): void {
  if (!isJsonObject(schema)) {
    return;
  }
  const text = JSON.stringify(schema);
  if (text.length >= MIN_SHARED_CHARS) {
    const seen = found.get(text);
    found.set(text, {
      count: (seen?.count ?? 0) + 1,
      name: seen?.name ?? name,
    });
  }
  for (const [key, item] of Object.entries(schema)) {
    if (SCHEMA_MAPS.has(key) && isJsonObject(item)) {
      for (const [childName, child] of Object.entries(item)) {
        countSubschemas(child, childName, found);
      }
    } else if (SCHEMA_SLOTS.has(key)) {
      for (const child of Array.isArray(item) ? item : [item]) {
        countSubschemas(child, name, found);
      }
    }
  }
}

function replaced(schema: JsonValue, text: string, ref: JsonObject): JsonValue {
  return mapSchemas(schema, (node) =>
    JSON.stringify(node) === text ? ref : node
  );
}

/**
 * The listed input schema with default keys dropped and each object subtree
 * that appears more than once moved into `$defs`, named after the property it
 * first appears under, and referenced by `$ref` where it stood.
 */
export function compactInputSchema(schema: JsonObject): JsonObject {
  const body = withoutDefaultKeys(schema);
  if (!isJsonObject(body)) {
    return schema;
  }
  let properties: JsonValue = { properties: body.properties ?? {} };
  const defs: JsonObject = {};
  // The largest repeated subtree first, so a repeat nested inside it is
  // counted once it has been hoisted rather than once per copy.
  for (;;) {
    const found = new Map<string, { count: number; name: string }>();
    countSubschemas(properties, "shared", found);
    for (const definition of Object.values(defs)) {
      countSubschemas(definition, "shared", found);
    }
    const largest = [...found.entries()]
      .filter(([, entry]) => entry.count > 1)
      .toSorted(([a], [b]) => b.length - a.length)[0];
    if (largest === undefined) {
      break;
    }
    const [text, entry] = largest;
    let name = entry.name;
    for (let suffix = 2; name in defs; suffix += 1) {
      name = `${entry.name}${suffix}`;
    }
    const ref: JsonObject = { $ref: `#/$defs/${name}` };
    properties = replaced(properties, text, ref);
    for (const [defName, definition] of Object.entries(defs)) {
      defs[defName] = replaced(definition, text, ref);
    }
    const parsed: JsonValue = JSON.parse(text);
    defs[name] = parsed;
  }
  const listed = isJsonObject(properties) ? properties.properties : undefined;
  const compacted: JsonObject = { ...body };
  if (listed !== undefined) {
    compacted.properties = listed;
  }
  return Object.keys(defs).length === 0
    ? compacted
    : { ...compacted, $defs: defs };
}

/**
 * The listed output schema without descriptions or default keys. A client
 * validates structured results against it; the tool's description already
 * says what the result means.
 */
export function compactOutputSchema(schema: JsonObject): JsonObject {
  const compacted = mapSchemas(withoutDefaultKeys(schema), (node) => {
    if (typeof node.description !== "string") {
      return node;
    }
    const { description: _description, ...kept } = node;
    return kept;
  });
  return isJsonObject(compacted) ? compacted : schema;
}
