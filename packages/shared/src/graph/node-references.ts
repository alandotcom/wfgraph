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

import type { JsonObject, JsonValue } from "#src/types/json";
import { isSafeRecordKey } from "#src/types/record-key";
import { matchesShowWhen, type ShowWhen } from "#src/types/show-when";
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
 * `type` is the whole of how a timestamp or duration is told apart from plain
 * text: JSON Schema's `format` keyword is read once in `schema-codec` and lands
 * here as `type: "timestamp"` or `type: "duration"`.
 *
 * `showWhen` belongs to action output fields: offer the path only when another
 * config key holds a given value. Absent means always offered. Event payload
 * fields do not use it.
 */
export type ReferenceField = {
  path: string;
  /** The author's own words for the field, absent when they wrote none. */
  description?: string;
  type?: WorkflowSchemaFieldType;
  nullable?: boolean;
  enumValues?: string[];
  showWhen?: ShowWhen;
};

/**
 * Catalog output fields this config currently makes addressable.
 *
 * Uses the same `showWhen` predicate as config inputs.
 */
export function fieldsVisibleForConfig(
  config: Record<string, unknown> | undefined,
  fields: readonly ReferenceField[]
): readonly ReferenceField[] {
  return fields.filter((field) => matchesShowWhen(config, field.showWhen));
}

/**
 * A reference field together with the node that produces it. This is what a
 * config form shows when it lists what is available from upstream.
 */
export type UpstreamField = ReferenceField & {
  sourceNodeId: string;
  sourceNodeName: string;
};

/** Turn one schema-tree node into the flat reference field that addresses it. */
function schemaFieldToReferenceField(
  field: WorkflowSchemaField,
  path: string,
  nullable: boolean
): ReferenceField {
  const description = field.description?.trim();

  return {
    path,
    ...(description ? { description } : {}),
    type: field.type,
    ...(nullable ? { nullable: true } : {}),
    ...(field.enumValues ? { enumValues: field.enumValues } : {}),
  };
}

/**
 * How many dotted segments below a node's output the walk will name.
 *
 * A schema describes a whole object graph, and the graph a library derives can
 * be deeper than anything a person would want to scroll: every level multiplies
 * the entries the picker lists. Three segments reaches
 * `appointment.patient.name`, which is past the depth any payload in this repo
 * nests, and stops there.
 *
 * The cap is also what makes the walk terminate. A schema tree assembled by
 * hand can point back at itself, and a bounded descent cannot go round it more
 * than three times, so no separate cycle check is needed. The trees that arrive
 * from `schema-codec` are already acyclic: a recursive schema describes itself
 * with a `$ref`, which that reader drops rather than following.
 */
const MAX_REFERENCE_FIELD_DEPTH = 3;

/**
 * Turn a schema tree into the flat list of paths a user can pick from.
 *
 * Container fields are emitted alongside their children, so a caller sees both
 * the whole object and every leaf inside it. Arrays of objects contribute
 * `name[0].child` paths; arrays of primitives contribute only the array itself,
 * because there is no child to name. An object with no named properties -- an
 * open record, or one whose properties the reader could not use -- has no
 * children to emit and stays a single entry.
 *
 * A derived path is reachable only when every ancestor on it is present, so its
 * nullability is the OR of its own and its ancestors'. Array `[0]` children are
 * nullable unless the array declares `minItems >= 1`, because the schema never
 * otherwise guarantees a first element.
 */
export function flattenSchemaToReferenceFields(
  schema: WorkflowSchemaField[]
): ReferenceField[] {
  return collectReferenceFields(schema, "", MAX_REFERENCE_FIELD_DEPTH, false);
}

function collectReferenceFields(
  schema: WorkflowSchemaField[],
  prefix: string,
  remainingDepth: number,
  ancestorNullable: boolean
): ReferenceField[] {
  if (remainingDepth <= 0) {
    return [];
  }

  const fields: ReferenceField[] = [];

  for (const field of schema) {
    const name = field.name.trim();
    if (!name) {
      continue;
    }

    const path = prefix ? `${prefix}.${name}` : name;
    const nullable = ancestorNullable || Boolean(field.nullable);
    fields.push(schemaFieldToReferenceField(field, path, nullable));

    const children = field.fields ?? [];
    if (children.length === 0) {
      continue;
    }

    if (field.type === "object") {
      fields.push(
        ...collectReferenceFields(children, path, remainingDepth - 1, nullable)
      );
      continue;
    }

    if (field.type === "array" && field.itemType === "object") {
      const elementNullable = nullable || (field.minItems ?? 0) < 1;
      fields.push(
        ...collectReferenceFields(
          children,
          `${path}[0]`,
          remainingDepth - 1,
          elementNullable
        )
      );
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
 * swallow the text that follows it. The label may not contain a dot, because
 * the first dot is what separates the label from the field path.
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

/**
 * Rewrite every template token inside a config or JSON value. Returning
 * `undefined` leaves that token as it was. The same reference comes back when
 * nothing changed, so a rename can tell a dirty config from an untouched one.
 *
 * Live node configs may hold `undefined` for optional keys the editor cleared
 * (`integrationId: undefined`). Those keys stay put; a JSON codec would reject
 * the whole object and skip the rewrite.
 */
export function mapTemplateTokens(
  value: Record<string, unknown>,
  rewrite: (token: TemplateToken) => string | undefined
): Record<string, unknown>;
export function mapTemplateTokens(
  value: JsonValue,
  rewrite: (token: TemplateToken) => string | undefined
): JsonValue;
export function mapTemplateTokens(
  value: unknown,
  rewrite: (token: TemplateToken) => string | undefined
): unknown {
  if (typeof value === "string") {
    return mapTemplateString(value, rewrite);
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const mapped = mapTemplateTokens(item, rewrite);
      if (mapped !== item) {
        changed = true;
      }
      return mapped;
    });
    return changed ? next : value;
  }

  if (typeof value === "object" && value !== null) {
    let changed = false;
    const remapped: Array<[string, unknown]> = [];
    for (const [key, nested] of Object.entries(value)) {
      const mapped = mapTemplateTokens(nested, rewrite);
      if (mapped !== nested) {
        changed = true;
      }
      remapped.push([key, mapped]);
    }
    return changed ? Object.fromEntries(remapped) : value;
  }

  return value;
}

function mapTemplateString(
  value: string,
  rewrite: (token: TemplateToken) => string | undefined
): string {
  let changed = false;
  const next = parseTemplate(value)
    .map((segment) => {
      if (segment.kind === "literal") {
        return segment.text;
      }

      const replacement = rewrite(segment.token);
      if (replacement === undefined || replacement === segment.token.raw) {
        return segment.token.raw;
      }

      changed = true;
      return replacement;
    })
    .join("");

  return changed ? next : value;
}

const BRACKET_INDEX_PATTERN = /\[(\d+)\]/g;
const PATH_PART_PATTERN = /^([^[]*)((?:\[\d+\])*)$/;

export type OutputPathStep =
  | { kind: "key"; key: string }
  | { kind: "index"; index: number };

/**
 * Plugin steps return `{ success, data }`. A user writing `{{@n1:Step.id}}`
 * means the `id` inside `data`, so the wrapper is transparent by default.
 *
 * The `data` key must be present, so `{ success: true }` on its own is a plain
 * output and stays whole.
 */
function isStepWrapper(
  value: JsonValue
): value is JsonObject & { success: boolean; data: JsonValue } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "success") &&
    typeof value.success === "boolean" &&
    Object.hasOwn(value, "data")
  );
}

/**
 * Step through a `{ success, data }` wrapper to the payload a reader means.
 *
 * Every reader of a node output goes through here, so the wrapper is transparent
 * in the same way everywhere: to a template token that names a field, and to a
 * CEL condition that reads bare field names out of a merged context.
 */
export function unwrapStepOutput(output: JsonValue): JsonValue {
  return isStepWrapper(output) ? output.data : output;
}

export function parseOutputPath(path: string): OutputPathStep[] | null {
  const steps: OutputPathStep[] = [];

  for (const part of path.split(".")) {
    const trimmed = part.trim();
    if (!trimmed) {
      return null;
    }

    const parsed = PATH_PART_PATTERN.exec(trimmed);
    if (!parsed) {
      return null;
    }

    const key = parsed[1];
    if (key.includes("]") || (key && !isSafeRecordKey(key))) {
      return null;
    }
    if (key) {
      steps.push({ kind: "key", key });
    }

    for (const match of trimmed.matchAll(BRACKET_INDEX_PATTERN)) {
      const index = Number(match[1]);
      if (!Number.isSafeInteger(index)) {
        return null;
      }
      steps.push({ kind: "index", index });
    }
  }

  return steps.length > 0 ? steps : null;
}

/**
 * Read one key off an output value. Arrays are excluded so that a path segment
 * naming a key does not start answering with array members such as `length`;
 * `name[0]` reaches array members through readIndex.
 */
function readKey(
  value: JsonValue | undefined,
  key: string
): JsonValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.hasOwn(value, key)
      ? value[key]
      : undefined
    : undefined;
}

function readIndex(
  value: JsonValue | undefined,
  index: number
): JsonValue | undefined {
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
export function resolveOutputPath(
  output: JsonValue,
  path: string
): JsonValue | undefined {
  if (!path.trim()) {
    return output;
  }
  const steps = parseOutputPath(path);
  if (!steps) {
    return undefined;
  }

  const first = steps[0];
  const firstKey = first.kind === "key" ? first.key : "";
  const namesWrapperKey =
    firstKey === "success" || firstKey === "data" || firstKey === "error";

  let current: JsonValue | undefined = namesWrapperKey
    ? output
    : unwrapStepOutput(output);

  for (const step of steps) {
    if (current === null || current === undefined) {
      return undefined;
    }

    current =
      step.kind === "key"
        ? readKey(current, step.key)
        : readIndex(current, step.index);
  }

  return current;
}
