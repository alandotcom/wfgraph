import { parse as parseCel } from "@marcbachmann/cel-js";
import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import { Schema } from "effect";
import type { ActionConfigField } from "#src/plugins/registry";
import type { JsonObject } from "#src/types/json";
import { asStandardSchema } from "#src/types/schema";
import { getValueByPath } from "#src/utils/object-path";
import type { InputSchema } from "#src/workflow/action-registry";
import {
  flattenSchemaToReferenceFields,
  type ReferenceField,
  schemaFieldToReferenceField,
} from "#src/workflow/node-references";
import {
  type ResolvedTriggerRouting,
  resolveTriggerRouting,
  type TriggerClassification,
} from "#src/workflow/routing-policy";
import {
  configFieldsFromJsonSchema,
  jsonSchemaLibraryOptions,
  parseWorkflowSchemaFieldsOrJsonSchema,
  type WorkflowSchemaField,
} from "#src/workflow/schema-codec";
import {
  createDefaultTriggerDefinition,
  createUnknownTriggerDefinition,
} from "#src/workflow/triggers/fallback-trigger";
import { createScheduleTriggerDefinition } from "#src/workflow/triggers/schedule-trigger";
import { createWebhookTriggerDefinition } from "#src/workflow/triggers/webhook-trigger";
import { asNonEmptyString } from "#src/workflow/webhook-routing";

export type TriggerExecutionType = "manual" | "webhook" | "event";

// Classification is vocabulary, not policy: the shape lives with the policy
// module that consumes it, and is re-exported here as part of the trigger
// definition surface.
export type { TriggerClassification } from "#src/workflow/routing-policy";

type TriggerSchemaSafeParseResult<TPayload> =
  | { success: true; data: TPayload }
  | { success: false; error?: unknown };

type TriggerSchemaSafeParse<TPayload> = {
  safeParse: (value: unknown) => TriggerSchemaSafeParseResult<TPayload>;
};

type TriggerSchemaStandardSuccess<TPayload> = {
  value: TPayload;
  issues?: undefined;
};

type TriggerSchemaStandardFailure = {
  issues: ReadonlyArray<{
    message: string;
    path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
  }>;
};

type TriggerSchemaStandardResult<TPayload> =
  | TriggerSchemaStandardSuccess<TPayload>
  | TriggerSchemaStandardFailure;

type TriggerSchemaStandard<TPayload> = {
  "~standard": {
    validate: (
      value: unknown
    ) =>
      | TriggerSchemaStandardResult<TPayload>
      | Promise<TriggerSchemaStandardResult<TPayload>>;
    /**
     * Schema libraries that also implement the Standard JSON Schema spec expose
     * this converter (Zod v4 and arktype both do). The registry calls it to
     * derive the trigger's output fields for template autocomplete. Optional
     * because the validation half of Standard Schema can be implemented alone.
     */
    jsonSchema?: StandardJSONSchemaV1.Converter;
  };
};

/**
 * The three forms a payload schema reaches this registry in.
 *
 * The first two are libraries that describe themselves: a `safeParse` method,
 * or Standard Schema. The third is a bare Effect schema, which carries neither
 * until it is asked to -- `createTrigger` asks, once, so an author writes
 * `schema: Schema.Struct({ ... })` with nothing wrapped around it.
 *
 * What the registry does with a schema, it does through whichever of the first
 * two shapes it finds, and that has not changed. Adding the third arm widened
 * what an author may write; it did not narrow what the registry accepts.
 */
export type TriggerPayloadSchema<TPayload> =
  | TriggerSchemaSafeParse<TPayload>
  | TriggerSchemaStandard<TPayload>
  | Schema.ConstraintDecoder<TPayload>;

type TriggerPathNonTraversable =
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

type TriggerPayloadPath<TPayload> = TPayload extends JsonObject
  ? {
      [Key in Extract<
        keyof TPayload,
        string
      >]: TPayload[Key] extends TriggerPathNonTraversable
        ? Key
        : TPayload[Key] extends JsonObject
          ? Key | `${Key}.${TriggerPayloadPath<TPayload[Key]>}`
          : Key;
    }[Extract<keyof TPayload, string>]
  : never;

type TriggerPayloadValueAtPath<
  TPayload,
  TPath extends string,
> = TPath extends `${infer Head}.${infer Tail}`
  ? Head extends keyof TPayload
    ? TriggerPayloadValueAtPath<TPayload[Head], Tail>
    : never
  : TPath extends keyof TPayload
    ? TPayload[TPath]
    : never;

type TriggerStringPath<TPayload> = {
  [Path in TriggerPayloadPath<TPayload>]: Extract<
    TriggerPayloadValueAtPath<TPayload, Path>,
    string
  > extends never
    ? never
    : Path;
}[TriggerPayloadPath<TPayload>];

type InngestConcurrencyOption =
  | number
  | { limit: number; key?: string; scope?: "fn" | "env" | "account" }
  | Array<{ limit: number; key?: string; scope?: "fn" | "env" | "account" }>;

export type InngestEventTriggerConfig = {
  eventNames: string[];
  functionOptions: Record<string, unknown>;
};

export type WorkflowTriggerRuntimeDefinition = {
  type: string;
  executionType: TriggerExecutionType;
  inngestEventTrigger?: InngestEventTriggerConfig;
  evaluate: (input: {
    config: Record<string, unknown> | undefined;
    payload: JsonObject;
    /**
     * The Inngest event name that delivered the payload, when there is one.
     * An event-mode trigger without `eventTypePath` classifies to this name.
     */
    eventName?: string;
  }) => TriggerClassification;
};

export type WorkflowTriggerUiDefinition = {
  label: string;
  description?: string;
  logoUrl?: string;
  configFields?: ActionConfigField[];
  outputFields?: ReferenceField[];
  /**
   * The closed Event Type vocabulary the editor renders as Routing Policy
   * rows and Wait node options. Undefined when the vocabulary is open (the
   * webhook trigger, or an `eventTypePath` pointing at a plain string).
   */
  eventTypes?: string[];
  /** The payload path the editor names when explaining correlation. */
  correlationPath?: string;
};

export type WorkflowTriggerDefinition = {
  runtime: WorkflowTriggerRuntimeDefinition;
  ui: WorkflowTriggerUiDefinition;
};

export type RuntimeExtensionTriggerDefinition = WorkflowTriggerDefinition & {
  readonly __runtimeExtensionTriggerBrand: true;
};

type CreateTriggerInputBase<TPayload extends JsonObject> = {
  /**
   * Unique identifier for this trigger type (e.g. `"AppointmentLifecycle"`).
   * Used to match trigger nodes in workflows to this definition.
   */
  type: string;

  /** Human-readable name shown in the workflow editor trigger selector. */
  label: string;

  /**
   * The schema that validates incoming payloads. Write it in Effect Schema,
   * Zod, or arktype -- whichever, it is passed as it is, with no wrapping.
   * Payloads that fail validation classify as `invalid_payload` and are ignored.
   * The schema's shape also drives `TriggerPayloadPath` autocomplete on path fields
   * like `correlationIdPath`, `eventTypePath`, `concurrency.key`, and `inngest.*.key`.
   */
  schema: TriggerPayloadSchema<TPayload>;

  /**
   * Dot-path into the validated payload that resolves to a unique string identifying
   * the entity this workflow instance tracks (e.g. `"appointment.id"`).
   * Only paths that resolve to `string` values are allowed.
   * Used for correlation: replace/cancel actions and wait resumption match against
   * in-flight executions that share the same correlation key.
   */
  correlationIdPath: TriggerStringPath<TPayload>;

  /**
   * Dot-path into the validated payload that names the Event Type (e.g.
   * `"event"`). When the path points at an enum, its values become the closed
   * vocabulary the editor offers for Routing Policy rows and Wait node
   * options. Optional in event mode, where omitting it makes the delivering
   * Inngest event name the Event Type; required in webhook mode, which has
   * no event name to fall back on.
   */
  eventTypePath?: TriggerStringPath<TPayload>;

  /** Optional description shown beneath the trigger label in the editor. */
  description?: string;

  /** Optional URL to a logo/icon displayed next to the trigger in the editor. */
  logoUrl?: string;

  /**
   * Optional Standard Schema for per-workflow trigger configuration.
   * Auto-derives `configFields` for the trigger config panel.
   * Different from `schema` which validates incoming event payloads.
   */
  configSchema?: InputSchema<Record<string, unknown>>;
};

/**
 * Webhook-mode trigger. Omit `event` (or set it to `undefined`) to receive
 * payloads via the workflow's webhook URL instead of Inngest events.
 * `concurrency` and `inngest` are not available in webhook mode, and
 * `eventTypePath` is required: with no Inngest event name to fall back on, a
 * webhook payload can only be classified by a path into it.
 */
type CreateTriggerInputWebhook<TPayload extends JsonObject> =
  CreateTriggerInputBase<TPayload> & {
    event?: undefined;
    eventTypePath: TriggerStringPath<TPayload>;
    concurrency?: never;
    inngest?: never;
  };

/**
 * Inngest concurrency control. All `key` values are schema-relative dot-paths
 * (e.g. `"appointment.id"`) and are automatically prefixed with `event.data.`
 * before being passed to Inngest.
 */
type TypedConcurrencyOption<TPayload extends JsonObject> =
  | number
  | {
      /** Maximum number of concurrent executions. */
      limit: number;
      /** Schema-relative dot-path to partition concurrency by (e.g. `"appointment.id"`). */
      key?: TriggerPayloadPath<TPayload>;
      /** Concurrency scope: per-function, per-environment, or per-account. */
      scope?: "fn" | "env" | "account";
    }
  | Array<{
      /** Maximum number of concurrent executions. */
      limit: number;
      /** Schema-relative dot-path to partition concurrency by (e.g. `"appointment.id"`). */
      key?: TriggerPayloadPath<TPayload>;
      /** Concurrency scope: per-function, per-environment, or per-account. */
      scope?: "fn" | "env" | "account";
    }>;

/**
 * Inngest function-level options with schema-relative paths.
 *
 * All `key` fields accept dot-paths relative to your schema
 * (e.g. `"entity.id"`) and are automatically prefixed with `event.data.`
 * before being passed to Inngest.
 *
 * `priority.run` accepts a CEL expression written against your schema
 * (e.g. `'appointment.priority == "high" ? 100 : 50'`). Identifiers are
 * validated against top-level schema keys and rewritten to `event.data.*`
 * at registration time.
 */
type TypedInngestFunctionOptions<TPayload extends JsonObject> = {
  /**
   * Limit how many times a function runs within a time period.
   * When `key` is set, the limit is tracked per unique key value.
   */
  rateLimit?: {
    /** Maximum number of runs allowed per `period`. */
    limit: number;
    /** Time window (e.g. `"1m"`, `"1h"`). */
    period: string;
    /** Schema-relative dot-path to partition the rate limit by. */
    key?: TriggerPayloadPath<TPayload>;
  };
  /**
   * Limit execution throughput over a rolling window.
   * Similar to rateLimit but uses a sliding-window algorithm.
   */
  throttle?: {
    /** Maximum number of runs in the rolling `period`. */
    limit: number;
    /** Rolling window duration (e.g. `"1h"`). */
    period: string;
    /** Schema-relative dot-path to partition the throttle by. */
    key?: TriggerPayloadPath<TPayload>;
    /** Number of burst executions allowed above the steady-state limit. */
    burst?: number;
  };
  /**
   * Debounce execution: delay running until no new matching event
   * arrives within `period`. Only the last event in the window is executed.
   */
  debounce?: {
    /** Debounce window (e.g. `"5s"`, `"1m"`). */
    period: string;
    /** Schema-relative dot-path to partition the debounce by. */
    key?: TriggerPayloadPath<TPayload>;
    /** Maximum time to wait before forcing execution (e.g. `"1h"`). */
    timeout?: string;
  };
  /**
   * Dynamic priority via a CEL expression evaluated at enqueue time.
   * The expression should return an integer; higher values run first.
   *
   * Write the expression against your schema — identifiers are rewritten
   * to `event.data.*` automatically.
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
    /** Max time to wait before the function starts (e.g. `"1h"`). */
    start?: string;
    /** Max time the function can run after starting (e.g. `"2h"`). */
    finish?: string;
  };
  /** Number of automatic retries on failure (default varies by Inngest plan). */
  retries?: number;
};

/**
 * Event-mode trigger. Setting `event` makes workflows listen for named
 * Inngest events instead of requiring webhook HTTP calls.
 */
type CreateTriggerInputEvent<TPayload extends JsonObject> =
  CreateTriggerInputBase<TPayload> & {
    /**
     * Inngest event name(s) this trigger listens for.
     * Your app sends these via `inngest.send({ name: "app/order.created", data: { ... } })`.
     * Pass an array to listen for multiple event names with a single trigger.
     */
    event: string | string[];

    /**
     * Inngest concurrency control. Pass a number for a simple limit, or an
     * object/array for key-partitioned concurrency.
     * `key` values are schema-relative (e.g. `"order.id"`) and auto-prefixed
     * with `event.data.`.
     *
     * Cannot be combined with `inngest.concurrency` (use one or the other).
     */
    concurrency?: TypedConcurrencyOption<TPayload>;

    /**
     * Additional Inngest function options (rate limiting, throttling,
     * debouncing, priority, timeouts, retries).
     *
     * All `key` fields are schema-relative dot-paths, auto-prefixed with `event.data.`.
     * `priority.run` accepts a CEL expression using schema-relative identifiers.
     *
     * @example
     * ```ts
     * inngest: {
     *   rateLimit: { limit: 10, period: "1m", key: "entity.id" },
     *   priority: { run: 'appointment.priority == "high" ? 100 : 50' },
     *   retries: 3,
     * }
     * ```
     */
    inngest?: TypedInngestFunctionOptions<TPayload>;
  };

export type CreateTriggerInput<TPayload extends JsonObject> =
  | CreateTriggerInputWebhook<TPayload>
  | CreateTriggerInputEvent<TPayload>;

function normalizeTriggerDefinition(
  definition: WorkflowTriggerDefinition
): WorkflowTriggerDefinition {
  const runtimeType = definition.runtime.type.trim();
  const label = definition.ui.label.trim();

  if (!runtimeType) {
    throw new Error("Trigger type must be a non-empty string");
  }

  if (!label) {
    throw new Error("Trigger label must be a non-empty string");
  }

  const logoUrl = definition.ui.logoUrl?.trim();

  return {
    runtime: {
      ...definition.runtime,
      type: runtimeType,
    },
    ui: {
      ...definition.ui,
      label,
      logoUrl: logoUrl || undefined,
      configFields: definition.ui.configFields ?? [],
    },
  };
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function isSafeParseSchema<TPayload>(
  schema: TriggerPayloadSchema<TPayload>
): schema is TriggerSchemaSafeParse<TPayload> {
  return "safeParse" in schema && typeof schema.safeParse === "function";
}

function isStandardSchema<TPayload>(
  schema: TriggerPayloadSchema<TPayload>
): schema is TriggerSchemaStandard<TPayload> {
  if (
    schema == null ||
    (typeof schema !== "object" && typeof schema !== "function")
  ) {
    return false;
  }
  return (
    "~standard" in schema && typeof schema["~standard"].validate === "function"
  );
}

function validateTriggerPayload<TPayload extends JsonObject>(
  schema: TriggerPayloadSchema<TPayload>,
  payload: JsonObject
): TPayload | undefined {
  if (isSafeParseSchema(schema)) {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return undefined;
    }
    return parsed.data;
  }

  if (!isStandardSchema(schema)) {
    return undefined;
  }

  const standardSchema = schema["~standard"];
  const parsed = standardSchema.validate(payload);

  if (isPromiseLike(parsed)) {
    throw new Error(
      "Trigger schema validation must be synchronous. Async Standard Schema validators are not supported."
    );
  }

  if (
    "issues" in parsed &&
    Array.isArray(parsed.issues) &&
    parsed.issues.length
  ) {
    return undefined;
  }

  if (!("value" in parsed)) {
    return undefined;
  }

  return parsed.value;
}

function prefixEventDataPath(path: string): string {
  return `event.data.${path}`;
}

function prefixKeyField<T extends { key?: string }>(obj: T): T {
  if (!obj.key) {
    return obj;
  }
  return { ...obj, key: prefixEventDataPath(obj.key) };
}

function prefixConcurrency(
  concurrency: TypedConcurrencyOption<JsonObject>
): InngestConcurrencyOption {
  if (typeof concurrency === "number") {
    return concurrency;
  }

  if (Array.isArray(concurrency)) {
    return concurrency.map(prefixKeyField);
  }

  return prefixKeyField(concurrency);
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
 * them -- the callers treat that as "no names known" and leave a CEL expression
 * or a reference list as they found it.
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
  // out of reach; `isStandardSchema` above admits both for the same reason.
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

  const sorted = identifiers.toSorted((a, b) => b.pos - a.pos);

  let result = expression;
  for (const { pos } of sorted) {
    result = `${result.slice(0, pos)}event.data.${result.slice(pos)}`;
  }

  return result;
}

function prefixInngestOptions<TPayload extends JsonObject>(
  inngest: TypedInngestFunctionOptions<TPayload>,
  schema: TriggerPayloadSchema<TPayload>
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
 * The payload schema as a field tree, when the schema can describe itself.
 * Only schemas that implement the JSON Schema half of Standard Schema can;
 * the rest fall back to key extraction downstream.
 */
function parseTriggerSchemaFields(
  schema: TriggerPayloadSchema<JsonObject>
): WorkflowSchemaField[] | undefined {
  if (!isStandardSchema(schema)) {
    return undefined;
  }

  const converter = schema["~standard"].jsonSchema;
  if (!converter) {
    return undefined;
  }

  try {
    const jsonSchema = converter.input({
      target: "draft-2020-12",
      libraryOptions: jsonSchemaLibraryOptions,
    });

    const fields = parseWorkflowSchemaFieldsOrJsonSchema(jsonSchema);
    return fields && fields.length > 0 ? fields : undefined;
  } catch {
    return undefined;
  }
}

function outputFieldsFromSchemaFields<TPayload extends JsonObject>(
  schemaFields: WorkflowSchemaField[] | undefined,
  schema: TriggerPayloadSchema<TPayload>
): ReferenceField[] {
  if (schemaFields) {
    return schemaFields.map((field) => schemaFieldToReferenceField(field));
  }

  // Fallback: the field names the schema object declares, when its JSON
  // Schema gave nothing.
  const schemaKeys = extractSchemaKeys(schema);
  if (schemaKeys && schemaKeys.length > 0) {
    return schemaKeys.map((key) => ({
      path: key,
      description: key,
    }));
  }

  return [];
}

/**
 * The enum values at a (possibly nested) dot-path into the payload schema.
 * `eventTypePath` accepts any depth, so the lookup flattens the field tree
 * rather than checking top-level names only.
 */
function enumValuesAtPath(
  schemaFields: WorkflowSchemaField[] | undefined,
  path: string
): string[] | undefined {
  if (!schemaFields) {
    return undefined;
  }
  return flattenSchemaToReferenceFields(schemaFields).find(
    (field) => field.path === path
  )?.enumValues;
}

function buildInngestEventTriggerConfig<TPayload extends JsonObject>(
  input: CreateTriggerInputEvent<TPayload>,
  schema: TriggerPayloadSchema<TPayload>
): InngestEventTriggerConfig {
  const rawEvents = Array.isArray(input.event) ? input.event : [input.event];
  const eventNames = rawEvents.map((e) => e.trim());

  for (const name of eventNames) {
    if (!name) {
      throw new Error("Trigger event names must be non-empty strings");
    }
  }

  const functionOptions: Record<string, unknown> = {};

  if (input.concurrency !== undefined) {
    functionOptions.concurrency = prefixConcurrency(input.concurrency);
  }

  if (input.inngest !== undefined) {
    if ("batchEvents" in input.inngest) {
      throw new Error(
        "batchEvents is not supported — it changes the handler signature and is incompatible with event listener triggers"
      );
    }
    if (input.concurrency !== undefined && "concurrency" in input.inngest) {
      throw new Error(
        "concurrency cannot be set on both the trigger and inngest options — use one or the other"
      );
    }
    Object.assign(functionOptions, prefixInngestOptions(input.inngest, schema));
  }

  return { eventNames, functionOptions };
}

/**
 * Create a typed trigger definition for use with `server.start({ triggers })`.
 *
 * Triggers define how external events enter the workflow system.
 * There are two modes:
 *
 * - **Webhook mode** (default) -- omit `event`. Payloads arrive via the
 *   workflow's webhook URL (`POST /api/workflows/:id/webhook`).
 *
 * - **Event mode** -- set `event` to one or more Inngest event names.
 *   Payloads arrive via `inngest.send(...)` from your application code.
 *   Enables `concurrency` and `inngest` options for flow control.
 *
 * A definition supplies vocabulary only: the schema, the Correlation Key
 * path, and the Event Type path. What each Event Type does to a run (start,
 * replace, cancel, ignore) is the workflow's Routing Policy, configured per
 * workflow in the editor (ADR 0001).
 *
 * All dot-path fields (`correlationIdPath`, `eventTypePath`,
 * `concurrency.key`, `inngest.*.key`) reference your schema directly -- the
 * `event.data.` prefix required by Inngest is added automatically.
 *
 * @example
 * ```ts
 * const trigger = createTrigger({
 *   type: "AppointmentLifecycle",
 *   label: "Appointment Lifecycle",
 *   event: "app/appointment.updated",
 *   schema: z.object({
 *     event: z.enum(["appointment.created", "appointment.rescheduled", "appointment.canceled"]),
 *     appointment: z.object({ id: z.string(), priority: z.string() }),
 *   }),
 *   correlationIdPath: "appointment.id",
 *   eventTypePath: "event",
 *   concurrency: { limit: 1, key: "appointment.id" },
 *   inngest: {
 *     priority: { run: 'appointment.priority == "high" ? 100 : 50' },
 *   },
 * });
 * ```
 */
export function createTrigger<TPayload extends JsonObject>(
  input: CreateTriggerInput<TPayload>
): RuntimeExtensionTriggerDefinition {
  // The one place a payload schema is bridged. Everything below reads a
  // library-agnostic shape and nothing below knows which library wrote it: what
  // `asStandardSchema` hands back for the Effect arm satisfies the Standard
  // Schema arm this union already had.
  const schema = asStandardSchema(input.schema);

  const triggerType = input.type.trim();
  const label = input.label.trim();
  const correlationIdPath = input.correlationIdPath.trim();
  const eventTypePath = input.eventTypePath?.trim();

  if (!triggerType) {
    throw new Error("Trigger type must be a non-empty string");
  }

  if (!label) {
    throw new Error("Trigger label must be a non-empty string");
  }

  if (!correlationIdPath) {
    throw new Error("Trigger correlationIdPath must be a non-empty string");
  }

  const inngestEventTrigger =
    input.event !== undefined
      ? buildInngestEventTriggerConfig(input, schema)
      : undefined;

  const executionType: TriggerExecutionType = inngestEventTrigger
    ? "event"
    : "webhook";

  if (executionType === "webhook" && !eventTypePath) {
    throw new Error(
      "Webhook-mode triggers require eventTypePath: without an Inngest event name to fall back on, payloads cannot be classified"
    );
  }

  let configFields: ActionConfigField[] | undefined;
  if (input.configSchema) {
    const configSchema = asStandardSchema(input.configSchema);
    try {
      const jsonSchema = configSchema["~standard"].jsonSchema.input({
        target: "draft-2020-12",
        libraryOptions: jsonSchemaLibraryOptions,
      });
      configFields = configFieldsFromJsonSchema(jsonSchema);
    } catch {
      configFields = undefined;
    }
  }

  const schemaFields = parseTriggerSchemaFields(schema);
  const outputFields = outputFieldsFromSchemaFields(schemaFields, schema);

  // The closed Event Type vocabulary the editor renders. An eventTypePath
  // pointing at a schema enum (at any depth) yields its values; an
  // event-mode trigger without a path is classified by event name, so the
  // declared names are the vocabulary. A path at a plain string leaves the
  // vocabulary open.
  const eventTypes = eventTypePath
    ? enumValuesAtPath(schemaFields, eventTypePath)
    : inngestEventTrigger?.eventNames;

  // A manual run has no delivering Inngest event. When exactly one event
  // name is declared, it is the unambiguous stand-in; classification owns
  // this rule so entrypoints need not know how eventName is consumed.
  const soleEventName =
    inngestEventTrigger?.eventNames.length === 1
      ? inngestEventTrigger.eventNames[0]
      : undefined;

  const definition = normalizeTriggerDefinition({
    runtime: {
      type: triggerType,
      executionType,
      inngestEventTrigger,
      evaluate({ config: _config, payload, eventName }) {
        const validatedPayload = validateTriggerPayload(schema, payload);
        if (!validatedPayload) {
          return { ok: false, reason: "invalid_payload" };
        }

        return {
          ok: true,
          eventType: eventTypePath
            ? asNonEmptyString(getValueByPath(validatedPayload, eventTypePath))
            : (asNonEmptyString(eventName) ?? soleEventName),
          correlationKey: asNonEmptyString(
            getValueByPath(validatedPayload, correlationIdPath)
          ),
        };
      },
    },
    ui: {
      label,
      description: input.description,
      logoUrl: input.logoUrl,
      configFields,
      outputFields: outputFields.length > 0 ? outputFields : undefined,
      eventTypes: eventTypes && eventTypes.length > 0 ? eventTypes : undefined,
      correlationPath: correlationIdPath,
    },
  });

  return {
    ...definition,
    __runtimeExtensionTriggerBrand: true,
  };
}

export type WorkflowTriggerMetadata = WorkflowTriggerUiDefinition & {
  type: string;
  executionType: TriggerExecutionType;
};

const defaultTrigger = normalizeTriggerDefinition(
  createDefaultTriggerDefinition()
);
const scheduleTrigger = normalizeTriggerDefinition(
  createScheduleTriggerDefinition()
);

const webhookTrigger = normalizeTriggerDefinition(
  createWebhookTriggerDefinition()
);

// Built-in triggers ship here. A project adds its own by passing them to
// `createRovaApp({ triggers })`, which calls `registerWorkflowTrigger(...)` for
// each one during startup.
const triggerRegistry = new Map<string, WorkflowTriggerDefinition>([
  [webhookTrigger.runtime.type, webhookTrigger],
  [scheduleTrigger.runtime.type, scheduleTrigger],
]);
const builtInTriggerTypes = new Set(triggerRegistry.keys());

export function registerWorkflowTrigger(
  definition: WorkflowTriggerDefinition
): void {
  const normalizedDefinition = normalizeTriggerDefinition(definition);
  const triggerType = normalizedDefinition.runtime.type;
  if (triggerRegistry.has(triggerType)) {
    throw new Error(`Trigger type "${triggerType}" is already registered`);
  }
  triggerRegistry.set(triggerType, normalizedDefinition);
}

export function unregisterWorkflowTrigger(triggerType: string): void {
  const normalizedType = triggerType.trim();
  if (!normalizedType || builtInTriggerTypes.has(normalizedType)) {
    return;
  }
  triggerRegistry.delete(normalizedType);
}

export function listWorkflowTriggers(): WorkflowTriggerMetadata[] {
  return Array.from(triggerRegistry.values()).map((definition) => ({
    type: definition.runtime.type,
    label: definition.ui.label,
    executionType: definition.runtime.executionType,
    description: definition.ui.description,
    logoUrl: definition.ui.logoUrl,
    configFields: definition.ui.configFields ?? [],
    outputFields: definition.ui.outputFields,
    eventTypes: definition.ui.eventTypes,
    correlationPath: definition.ui.correlationPath,
  }));
}

export function listCustomWorkflowTriggers(): WorkflowTriggerMetadata[] {
  return listWorkflowTriggers().filter(
    (definition) =>
      definition.type !== webhookTrigger.runtime.type &&
      definition.type !== scheduleTrigger.runtime.type
  );
}

export function resolveWorkflowTriggerDefinition(
  config: Record<string, unknown> | undefined
): WorkflowTriggerDefinition {
  const triggerType = asNonEmptyString(config?.triggerType);

  if (!triggerType) {
    return defaultTrigger;
  }

  return (
    triggerRegistry.get(triggerType) ??
    normalizeTriggerDefinition(createUnknownTriggerDefinition(triggerType))
  );
}

export function evaluateWorkflowTrigger(input: {
  config: Record<string, unknown> | undefined;
  payload: JsonObject;
  eventName?: string;
}): TriggerClassification {
  const trigger = resolveWorkflowTriggerDefinition(input.config);
  return trigger.runtime.evaluate(input);
}

/**
 * Classification and policy resolution in one step: what every entrypoint
 * does with an incoming payload before orchestrating.
 */
export function routeWorkflowTrigger(input: {
  config: Record<string, unknown> | undefined;
  payload: JsonObject;
  eventName?: string;
}): ResolvedTriggerRouting {
  return resolveTriggerRouting({
    classification: evaluateWorkflowTrigger(input),
    config: input.config,
  });
}
