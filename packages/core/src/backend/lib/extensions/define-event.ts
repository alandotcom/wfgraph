/**
 * An Event: a name, a payload shape, and where that payload carries its Entity
 * Value.
 *
 * An Event holds no lifecycle role and no routing. Which Events start a run and
 * which cancel it is the Workflow Builder's declaration on the Lifecycle Node,
 * per workflow, so the Event Author supplies vocabulary and nothing else
 * (ADR-0007).
 *
 * `defineEvent` registers nothing. It returns a plain value the host passes to
 * `createRovaApp`, which assembles the one catalog the editor reads.
 */

import { parse as parseCel } from "@marcbachmann/cel-js";
import type { Schema } from "effect";
import type { JsonObject } from "@rova/shared/types/json";
import {
  asStandardSchema,
  type StandardSchema,
} from "@rova/shared/types/schema";
import type { ReferenceField } from "@rova/shared/workflow/node-references";
import { requireOutputFieldsFromSchema } from "@rova/shared/workflow/output-fields";

/**
 * What an Event's payload schema may be written in: any Standard Schema library,
 * or a bare Effect schema, which is bridged here rather than by its author.
 *
 * Both halves of Standard Schema are needed from one object. The validate half
 * checks an arriving payload; the JSON Schema half is where `payloadFields`
 * comes from, so a library that describes only how to validate cannot define an
 * Event. Zod and arktype each publish both.
 */
export type PayloadSchema<TPayload> =
  | StandardSchema<TPayload>
  | Schema.ConstraintDecoder<TPayload>;

type EventPathNonTraversable =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | RegExp
  | ((...args: never[]) => unknown)
  | readonly unknown[];

type EventPayloadPath<TPayload> = TPayload extends JsonObject
  ? {
      [Key in Extract<
        keyof TPayload,
        string
      >]: TPayload[Key] extends EventPathNonTraversable
        ? Key
        : TPayload[Key] extends JsonObject
          ? Key | `${Key}.${EventPayloadPath<TPayload[Key]>}`
          : Key;
    }[Extract<keyof TPayload, string>]
  : never;

type EventPayloadValueAtPath<
  TPayload,
  TPath extends string,
> = TPath extends `${infer Head}.${infer Tail}`
  ? Head extends keyof TPayload
    ? EventPayloadValueAtPath<TPayload[Head], Tail>
    : never
  : TPath extends keyof TPayload
    ? TPayload[TPath]
    : never;

/**
 * A dot-path into the payload that resolves to a string.
 *
 * An Entity Value is a string, so this is what a Correlation Path may be. The
 * check sits beside the schema it walks, one call away from where the path is
 * written.
 */
export type EventStringPath<TPayload> = {
  [Path in EventPayloadPath<TPayload>]: Extract<
    EventPayloadValueAtPath<TPayload, Path>,
    string
  > extends never
    ? never
    : Path;
}[EventPayloadPath<TPayload>];

/**
 * Inngest flow control for this Event's listener, written against the payload.
 *
 * Every `key` is a schema-relative dot-path (`"appointment.id"`) and
 * `priority.run` is a CEL expression over the payload's top-level keys. Both are
 * rewritten to the `event.data.` form Inngest wants at definition, so a bad path
 * or a bad identifier fails where it was written.
 *
 * Inngest `concurrency` is not a member. Per-Entity-Value serialization is
 * Rova's Concurrency on the Lifecycle Node, which Inngest's version cannot
 * stand in for: it can neither end a displaced run with the `superseded` status
 * nor refuse a start and say so in run history.
 */
export type InngestEventOptions<TPayload extends JsonObject> = {
  /**
   * Limit how many times the listener runs within a time period. When `key` is
   * set, the limit is tracked per unique key value.
   */
  rateLimit?: {
    /** Maximum number of runs allowed per `period`. */
    limit: number;
    /** Time window (e.g. `"1m"`, `"1h"`). */
    period: string;
    /** Schema-relative dot-path to partition the rate limit by. */
    key?: EventPayloadPath<TPayload>;
  };
  /** Limit throughput over a rolling window. */
  throttle?: {
    /** Maximum number of runs in the rolling `period`. */
    limit: number;
    /** Rolling window duration (e.g. `"1h"`). */
    period: string;
    /** Schema-relative dot-path to partition the throttle by. */
    key?: EventPayloadPath<TPayload>;
    /** Number of burst runs allowed above the steady-state limit. */
    burst?: number;
  };
  /**
   * Delay running until no new matching Event arrives within `period`. Only the
   * last Event in the window is delivered.
   */
  debounce?: {
    /** Debounce window (e.g. `"5s"`, `"1m"`). */
    period: string;
    /** Schema-relative dot-path to partition the debounce by. */
    key?: EventPayloadPath<TPayload>;
    /** Maximum time to wait before forcing delivery (e.g. `"1h"`). */
    timeout?: string;
  };
  /**
   * Dynamic priority, evaluated at enqueue time. Higher runs first.
   *
   * @example
   * ```ts
   * priority: { run: 'appointment.priority == "high" ? 100 : 50' }
   * // becomes: 'event.data.appointment.priority == "high" ? 100 : 50'
   * ```
   */
  priority?: {
    /** CEL expression using schema-relative identifiers. */
    run: string;
  };
  /** Inngest timeout overrides. */
  timeouts?: {
    /** Max time to wait before the listener starts (e.g. `"1h"`). */
    start?: string;
    /** Max time it may run after starting (e.g. `"2h"`). */
    finish?: string;
  };
  /** Number of automatic retries on failure. */
  retries?: number;
};

/** How an Event arrives, when the transport differs from the Event's identity. */
export type EventSource = {
  readonly event: string;
  readonly when?: { readonly path: string; readonly equals: string };
};

export type EventDefinition<TPayload extends JsonObject> = {
  readonly kind: "event";
  /** The Event's identity in Rova, and by default the name it arrives under. */
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly schema: StandardSchema<TPayload>;
  /**
   * Where this payload carries its Entity Value.
   *
   * Optional, because an imported Event may have no path its author knew to
   * declare, and the Workflow Builder then supplies one in the Lifecycle panel.
   */
  readonly correlationPath?: string;
  readonly source: EventSource;
  /**
   * The flow control above, in the form Inngest's `createFunction` takes: each
   * `key` prefixed and `priority.run` rewritten. The authored form is not kept,
   * because nothing downstream has a use for a path Inngest would reject.
   */
  readonly inngestFunctionOptions?: Record<string, unknown>;
  /** Derived once, at definition. What the editor lists. */
  readonly payloadFields: readonly ReferenceField[];
  /** Phantom, so the payload type stays inferable at a call site. */
  readonly _payload?: TPayload;
};

/** An Event definition of any payload, which is what a list of them holds. */
export type AnyEventDefinition = EventDefinition<JsonObject>;

export type DefineEventInput<TPayload extends JsonObject> = {
  /**
   * The Event's identity in Rova. One Event per name, and per thing that
   * happened: an app declares `appointment.created` and `appointment.canceled`
   * separately rather than one umbrella Event with a subtype field, because the
   * lifecycle model's rules are stated over Event names.
   */
  readonly name: string;
  /** Defaults to the name. */
  readonly label?: string;
  readonly description?: string;
  readonly schema: PayloadSchema<TPayload>;
  readonly correlationPath?: EventStringPath<TPayload>;
  /**
   * How the Event arrives, for an existing bus that sends one umbrella name and
   * cannot change. Identity stays the Rova name above, so the lifecycle model is
   * untouched, and `when` becomes the listener's filter so Inngest still does
   * the narrowing.
   *
   * Defaults to `{ event: name }`.
   */
  readonly source?: {
    readonly event: string;
    readonly when?: {
      readonly path: EventStringPath<TPayload>;
      readonly equals: string;
    };
  };
  readonly inngest?: InngestEventOptions<TPayload>;
};

function prefixEventDataPath(path: string): string {
  return `event.data.${path}`;
}

function prefixKeyField<T extends { key?: string }>(obj: T): T {
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
 * The top-level field names a payload schema declares, read off the object the
 * schema library exposes rather than off its JSON Schema.
 *
 * None of the property names below is Standard Schema, which is why this
 * answers `undefined` rather than throwing for a library that publishes none of
 * them -- the caller treats that as "no names known" and leaves the CEL
 * expression's identifiers unchecked.
 */
function fieldNamesOf(declared: unknown): string[] | undefined {
  return typeof declared === "object" && declared !== null
    ? Object.keys(declared)
    : undefined;
}

/**
 * Three property names, because two libraries and two Effect shapes. Zod calls
 * it `shape`; `Schema.Struct` calls it `fields`; `Schema.StructWithRest` -- the
 * shape an open payload schema has -- carries neither, and exposes the struct it
 * wraps as `schema`, whose own `fields` are the names wanted here.
 *
 * Each check falls through rather than answering, because a property being
 * present says nothing about it holding an object of field names: a payload
 * schema is free to declare a field literally called `shape`.
 */
function extractSchemaKeys(schema: unknown): string[] | undefined {
  // An Effect schema is callable, so `typeof` answers "function" for every one
  // of them. Testing for an object alone would put both Effect branches below
  // out of reach.
  if (
    (typeof schema !== "object" && typeof schema !== "function") ||
    schema === null
  ) {
    return undefined;
  }

  if ("shape" in schema) {
    const names = fieldNamesOf(schema.shape);
    if (names) {
      return names;
    }
  }

  if ("fields" in schema) {
    const names = fieldNamesOf(schema.fields);
    if (names) {
      return names;
    }
  }

  return "schema" in schema ? extractSchemaKeys(schema.schema) : undefined;
}

function rewriteCelExpression(
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

function prefixInngestOptions<TPayload extends JsonObject>(
  inngest: InngestEventOptions<TPayload>,
  schema: StandardSchema<TPayload>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (inngest.rateLimit) {
    result.rateLimit = prefixKeyField(inngest.rateLimit);
  }

  if (inngest.throttle) {
    result.throttle = prefixKeyField(inngest.throttle);
  }

  if (inngest.debounce) {
    result.debounce = prefixKeyField(inngest.debounce);
  }

  if (inngest.priority) {
    const schemaKeys = extractSchemaKeys(schema);
    result.priority = {
      run: rewriteCelExpression(inngest.priority.run, schemaKeys),
    };
  }

  if (inngest.timeouts) {
    result.timeouts = inngest.timeouts;
  }

  if (inngest.retries !== undefined) {
    result.retries = inngest.retries;
  }

  return result;
}

/**
 * Two members of Inngest's option bag are refused rather than ignored.
 *
 * `batchEvents` changes the handler signature, so a listener cannot honour it.
 * `concurrency` would silently take over the job Concurrency on the Lifecycle
 * Node does, and would do it without a status or a run-history row. Neither is
 * in the type above, so this catches the object that reached here by a spread.
 */
function assertNoRetiredInngestOptions(
  eventName: string,
  inngest: InngestEventOptions<JsonObject>
): void {
  if ("batchEvents" in inngest) {
    throw new Error(
      `Event "${eventName}" sets inngest.batchEvents, which changes the handler signature and cannot be honoured by an Event listener.`
    );
  }

  if ("concurrency" in inngest) {
    throw new Error(
      `Event "${eventName}" sets inngest.concurrency. How many runs may exist per Entity Value is Concurrency on the workflow's Lifecycle Node, which Inngest's concurrency cannot express: it can neither end a displaced run with a status nor record a refused start.`
    );
  }
}

/**
 * Define an Event.
 *
 * The schema crosses the Standard Schema bridge here, once, and `payloadFields`
 * is derived from it on the spot: an Event's field list is fixed the moment it is
 * defined, so nothing later has to derive it again or hold a hand-written copy.
 *
 * Send an Event from your app through Inngest:
 *
 *     inngest.send({ name: "app/appointment.created", data: { ... } });
 *
 * or post it, which needs no Inngest client:
 *
 *     POST /api/events/app%2Fappointment.created
 */
export function defineEvent<TPayload extends JsonObject>(
  input: DefineEventInput<TPayload>
): EventDefinition<TPayload> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("An Event's name must be a non-empty string");
  }

  const label = input.label?.trim() || name;

  // The one place a payload schema is bridged, so the parse options a decode
  // would carry are decided once and by this call.
  const schema = asStandardSchema(input.schema);

  const sourceEvent = input.source?.event.trim() || name;
  const when = input.source?.when;

  if (input.inngest) {
    assertNoRetiredInngestOptions(name, input.inngest);
  }

  const inngestFunctionOptions = input.inngest
    ? prefixInngestOptions(input.inngest, schema)
    : undefined;

  return {
    kind: "event",
    name,
    label,
    description: input.description,
    schema,
    correlationPath: input.correlationPath?.trim() || undefined,
    source: when ? { event: sourceEvent, when } : { event: sourceEvent },
    inngestFunctionOptions,
    payloadFields: requireOutputFieldsFromSchema(`Event "${name}"`, schema),
  };
}
