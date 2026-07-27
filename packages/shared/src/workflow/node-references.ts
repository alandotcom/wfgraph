/**
 * Everything about "a field a workflow node can offer another node".
 *
 * Three things live here because they are the same idea seen from three sides:
 *  - the flat reference field: one leaf a user can drop into a template;
 *  - the template grammar: how that leaf is written down inside a config string;
 *  - the path walker: how that written-down leaf is turned back into a value at run time.
 *
 * Keeping them together means the autocomplete cannot offer a path shape the
 * resolver refuses to walk.
 *
 * The schema *tree* is a separate concern and stays in `./schema-codec` as
 * `WorkflowSchemaField`. This module reads that tree and flattens it.
 */

import type {
  WorkflowSchemaField,
  WorkflowSchemaFieldType,
} from "./schema-codec";

/**
 * One leaf that a user can reference from a template, addressed by a dotted path.
 *
 * `path` uses dots for nested objects and a `[0]` suffix for array elements,
 * for example `order.items[0].sku`. It is the exact string that goes after the
 * node label inside a template token, and the exact string the walker consumes.
 *
 * Known redundancy: `type: "timestamp"` and `format: "timestamp"` say the same
 * thing. Folding `format` into `type` would change the serialized schema
 * contract and needs a read-side migration, so both are kept for now.
 */
export type ReferenceField = {
  path: string;
  description: string;
  type?: WorkflowSchemaFieldType;
  format?: "timestamp";
  nullable?: boolean;
  enumValues?: string[];
};

/**
 * A reference field together with the node that produces it. This is what a
 * config form shows when it lists what is available from upstream.
 */
export type UpstreamField = ReferenceField & {
  sourceNodeId: string;
  sourceNodeName: string;
};

/** Human-readable stand-in for a description the schema author left out. */
function describeSchemaField(field: WorkflowSchemaField): string {
  if (field.description?.trim()) {
    return field.description.trim();
  }

  return field.type === "array"
    ? `${field.itemType ?? "string"}[]`
    : field.type;
}

/**
 * Turn one schema-tree node into the flat reference field that addresses it.
 *
 * The path defaults to the field's own name, which is what a caller wants when
 * it is converting a top-level schema without descending into children.
 */
export function schemaFieldToReferenceField(
  field: WorkflowSchemaField,
  path: string = field.name
): ReferenceField {
  return {
    path,
    description: describeSchemaField(field),
    type: field.type,
    ...(field.type === "timestamp" ? { format: "timestamp" as const } : {}),
    ...(field.nullable ? { nullable: true } : {}),
    ...(field.enumValues ? { enumValues: field.enumValues } : {}),
  };
}

/**
 * Turn a schema tree into the flat list of paths a user can pick from.
 *
 * Container fields are emitted alongside their children, so a user can reference
 * a whole object as well as any leaf inside it. Arrays of objects contribute
 * `name[0].child` paths; arrays of primitives contribute only the array itself,
 * since there is no child to name.
 */
export function flattenSchemaToReferenceFields(
  schema: WorkflowSchemaField[],
  prefix = ""
): ReferenceField[] {
  const fields: ReferenceField[] = [];

  for (const field of schema) {
    const name = field.name.trim();
    if (!name) {
      continue;
    }

    const path = prefix ? `${prefix}.${name}` : name;
    fields.push(schemaFieldToReferenceField(field, path));

    const children = field.fields ?? [];
    if (children.length === 0) {
      continue;
    }

    if (field.type === "object") {
      fields.push(...flattenSchemaToReferenceFields(children, path));
      continue;
    }

    if (field.type === "array" && field.itemType === "object") {
      fields.push(...flattenSchemaToReferenceFields(children, `${path}[0]`));
    }
  }

  return fields;
}

/**
 * The one place the template grammar is written down.
 *
 * A token is `{{@nodeId:NodeLabel}}` or `{{@nodeId:NodeLabel.field.path}}`. The
 * node id is what actually resolves at run time; the label is carried along so
 * the editor can show something readable and detect a renamed node.
 *
 * Neither the id nor the body may contain a brace, so a malformed token cannot
 * swallow the text that follows it. The label may not contain a dot, since the
 * first dot is what separates the label from the field path.
 */
const TEMPLATE_TOKEN_PATTERN = /\{\{@([^:{}]+):([^{}]+)\}\}/g;

/** A single `{{@nodeId:Label.field}}` reference located inside a larger string. */
export type TemplateToken = {
  /** The exact source text of the token, braces included. */
  raw: string;
  nodeId: string;
  nodeLabel: string;
  /** Dotted path into the node's output; empty when the token names the whole output. */
  fieldPath: string;
  /** Index of the token's first character in the source string. */
  start: number;
  /** Index just past the token's last character in the source string. */
  end: number;
};

/** A template string read as an ordered run of plain text and node references. */
export type TemplateSegment =
  | { kind: "literal"; text: string }
  | { kind: "token"; token: TemplateToken };

function toTemplateToken(match: RegExpExecArray): TemplateToken {
  const [raw, nodeId, body] = match;
  const dotIndex = body.indexOf(".");

  return {
    raw,
    nodeId,
    nodeLabel: dotIndex === -1 ? body : body.slice(0, dotIndex),
    fieldPath: dotIndex === -1 ? "" : body.slice(dotIndex + 1),
    start: match.index,
    end: match.index + raw.length,
  };
}

/** Every node reference in the string, in the order they appear. */
export function findTemplateTokens(value: string): TemplateToken[] {
  // A fresh regex each call keeps the shared `lastIndex` of a global regex
  // from leaking between callers.
  const pattern = new RegExp(TEMPLATE_TOKEN_PATTERN.source, "g");
  const tokens: TemplateToken[] = [];

  let match = pattern.exec(value);
  while (match !== null) {
    tokens.push(toTemplateToken(match));
    match = pattern.exec(value);
  }

  return tokens;
}

/**
 * The first node reference in the string, or null when there is none. Useful
 * when a string is expected to be a single token, such as one badge's value.
 */
export function matchTemplateToken(value: string): TemplateToken | null {
  const match = new RegExp(TEMPLATE_TOKEN_PATTERN.source).exec(value);
  return match === null ? null : toTemplateToken(match);
}

/**
 * Read the whole string as alternating literals and tokens. Concatenating every
 * segment's source text reproduces the input exactly, which is what lets a
 * renderer emit a badge per token without losing the surrounding prose.
 */
export function parseTemplate(value: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let cursor = 0;

  for (const token of findTemplateTokens(value)) {
    if (token.start > cursor) {
      segments.push({
        kind: "literal",
        text: value.slice(cursor, token.start),
      });
    }
    segments.push({ kind: "token", token });
    cursor = token.end;
  }

  if (cursor < value.length) {
    segments.push({ kind: "literal", text: value.slice(cursor) });
  }

  return segments;
}

/** Build a token in canonical form, so callers stop concatenating braces by hand. */
export function formatTemplateToken(input: {
  nodeId: string;
  nodeLabel: string;
  fieldPath?: string;
}): string {
  const suffix = input.fieldPath ? `.${input.fieldPath}` : "";
  return `{{@${input.nodeId}:${input.nodeLabel}${suffix}}}`;
}

/** One dot-separated piece of a path: a key, then any bracket indices after it. */
type PathSegment = { key: string; indices: number[] };

const BRACKET_INDEX_PATTERN = /\[(\d+)\]/g;

/**
 * Plugin steps return `{ success, data }`. A user writing `{{@n1:Step.id}}`
 * means the `id` inside `data`, so the wrapper is transparent by default.
 *
 * The `data` key must be present, so `{ success: true }` on its own is a plain
 * output and stays whole.
 */
function isStepWrapper(
  value: unknown
): value is { success: boolean; data: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, "success") === "boolean" &&
    "data" in value
  );
}

/**
 * Step through a `{ success, data }` wrapper to the payload a reader means.
 *
 * Every reader of a node output goes through here, so the wrapper is transparent
 * in the same way everywhere: to a template token that names a field, and to a
 * CEL condition that reads bare field names out of a merged context.
 */
export function unwrapStepOutput(output: unknown): unknown {
  return isStepWrapper(output) ? output.data : output;
}

function parsePathSegments(path: string): PathSegment[] {
  return path.split(".").flatMap((part) => {
    const trimmed = part.trim();
    if (!trimmed) {
      return [];
    }

    const indices = Array.from(
      trimmed.matchAll(BRACKET_INDEX_PATTERN),
      (match) => Number.parseInt(match[1], 10)
    );
    const bracketStart = trimmed.indexOf("[");
    const key = bracketStart === -1 ? trimmed : trimmed.slice(0, bracketStart);

    return [{ key, indices }];
  });
}

/**
 * Read one key off an output value. Arrays are excluded so that a path segment
 * naming a key does not start answering with array members such as `length`;
 * `name[0]` reaches array members through readIndex.
 */
function readKey(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;
}

function readIndex(value: unknown, index: number): unknown {
  return Array.isArray(value) ? value[index] : undefined;
}

/**
 * Resolve a dotted path against a node's output.
 *
 * Handles the two shapes the rest of the system produces: the `{ success, data }`
 * wrapper that plugin steps return, which is stepped into automatically unless
 * the path explicitly names `success`, `data`, or `error`; and the `name[0]`
 * bracket segments the flattener emits for arrays.
 *
 * Returns `undefined` when the path does not resolve, so a caller can tell a
 * missing key apart from a stored `null`.
 */
export function resolveOutputPath(output: unknown, path: string): unknown {
  const segments = parsePathSegments(path);
  if (segments.length === 0) {
    return output;
  }

  const firstKey = segments[0].key;
  const namesWrapperKey =
    firstKey === "success" || firstKey === "data" || firstKey === "error";

  let current: unknown = namesWrapperKey ? output : unwrapStepOutput(output);

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }

    // A leading `[0]` has no key, so the indices apply to `current` directly.
    if (segment.key) {
      current = readKey(current, segment.key);
    }

    for (const index of segment.indices) {
      current = readIndex(current, index);
    }
  }

  return current;
}
