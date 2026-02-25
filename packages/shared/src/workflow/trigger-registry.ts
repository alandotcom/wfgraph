import { parse as parseCel } from "@marcbachmann/cel-js";
import type { ActionConfigField, OutputField } from "@/plugins/registry";
import { getValueByPath } from "@/utils/object-path";
import type { InputSchema } from "@/workflow/action-registry";
import type { WorkflowSchemaField } from "@/workflow/schema-codec";
import {
  configFieldsFromJsonSchema,
  parseWorkflowSchemaFieldsOrJsonSchema,
} from "@/workflow/schema-codec";
import {
  createDefaultTriggerDefinition,
  createUnknownTriggerDefinition,
} from "@/workflow/triggers/fallback-trigger";
import { createScheduleTriggerDefinition } from "@/workflow/triggers/schedule-trigger";
import { createWebhookTriggerDefinition } from "@/workflow/triggers/webhook-trigger";
import { asNonEmptyString } from "@/workflow/webhook-routing";

export type TriggerExecutionType = "manual" | "webhook" | "event";

export type TriggerRoutingDecision =
  | { kind: "start" }
  | { kind: "restart" }
  | { kind: "stop" }
  | { kind: "ignore"; reason: "missing_event_type" | "event_not_configured" };

export type TriggerEvaluation = {
  eventType: string | undefined;
  correlationKey: string | undefined;
  routingDecision: TriggerRoutingDecision;
};

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
  };
};

export type TriggerPayloadSchema<TPayload> =
  | TriggerSchemaSafeParse<TPayload>
  | TriggerSchemaStandard<TPayload>;

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

type TriggerPayloadPath<TPayload> =
  TPayload extends Record<string, unknown>
    ? {
        [Key in Extract<
          keyof TPayload,
          string
        >]: TPayload[Key] extends TriggerPathNonTraversable
          ? Key
          : TPayload[Key] extends Record<string, unknown>
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

type TriggerLifecycleHandlerInput<TPayload extends Record<string, unknown>> = {
  payload: TPayload;
};

export type TriggerLifecycleInput<TPayload extends Record<string, unknown>> = {
  onStart: (input: TriggerLifecycleHandlerInput<TPayload>) => boolean;
  onRestart: (input: TriggerLifecycleHandlerInput<TPayload>) => boolean;
  onStop: (input: TriggerLifecycleHandlerInput<TPayload>) => boolean;
};

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
    payload: Record<string, unknown>;
  }) => TriggerEvaluation;
};

export type WorkflowTriggerUiDefinition = {
  label: string;
  description?: string;
  logoUrl?: string;
  configFields?: ActionConfigField[];
  outputFields?: OutputField[];
};

export type WorkflowTriggerDefinition = {
  runtime: WorkflowTriggerRuntimeDefinition;
  ui: WorkflowTriggerUiDefinition;
};

export type RuntimeExtensionTriggerDefinition = WorkflowTriggerDefinition & {
  readonly __runtimeExtensionTriggerBrand: true;
};

type CreateTriggerInputBase<TPayload extends Record<string, unknown>> = {
  /**
   * Unique identifier for this trigger type (e.g. `"AppointmentLifecycle"`).
   * Used to match trigger nodes in workflows to this definition.
   */
  type: string;

  /** Human-readable name shown in the workflow editor trigger selector. */
  label: string;

  /**
   * Zod or Standard Schema that validates incoming payloads.
   * Payloads that fail validation are ignored (routing decision `"event_not_configured"`).
   * The schema's shape also drives `TriggerPayloadPath` autocomplete on path fields
   * like `correlationIdPath`, `concurrency.key`, and `inngest.*.key`.
   */
  schema: TriggerPayloadSchema<TPayload>;

  /**
   * Dot-path into the validated payload that resolves to a unique string identifying
   * the entity this workflow instance tracks (e.g. `"appointment.id"`).
   * Only paths that resolve to `string` values are allowed.
   * Used for correlation: restart/stop decisions match against running executions
   * that share the same correlation key.
   */
  correlationIdPath: TriggerStringPath<TPayload>;

  /**
   * Routing callbacks that decide what happens when a payload arrives.
   * Each receives the validated payload and returns `true` to claim the event.
   * Evaluated in order: `onStop` > `onRestart` > `onStart`.
   * If none return `true`, the event is ignored.
   */
  lifecycle: TriggerLifecycleInput<TPayload>;

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
 * `concurrency` and `inngest` are not available in webhook mode.
 */
type CreateTriggerInputWebhook<TPayload extends Record<string, unknown>> =
  CreateTriggerInputBase<TPayload> & {
    event?: undefined;
    concurrency?: never;
    inngest?: never;
  };

/**
 * Inngest concurrency control. All `key` values are schema-relative dot-paths
 * (e.g. `"appointment.id"`) and are automatically prefixed with `event.data.`
 * before being passed to Inngest.
 */
type TypedConcurrencyOption<TPayload extends Record<string, unknown>> =
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
type TypedInngestFunctionOptions<TPayload extends Record<string, unknown>> = {
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
type CreateTriggerInputEvent<TPayload extends Record<string, unknown>> =
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

export type CreateTriggerInput<TPayload extends Record<string, unknown>> =
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

function triggerStartEvaluation(input?: {
  eventType?: string;
  correlationKey?: string;
}): TriggerEvaluation {
  return {
    eventType: input?.eventType,
    correlationKey: input?.correlationKey,
    routingDecision: { kind: "start" },
  };
}

function triggerRestartEvaluation(input?: {
  eventType?: string;
  correlationKey?: string;
}): TriggerEvaluation {
  return {
    eventType: input?.eventType,
    correlationKey: input?.correlationKey,
    routingDecision: { kind: "restart" },
  };
}

function triggerStopEvaluation(input?: {
  eventType?: string;
  correlationKey?: string;
}): TriggerEvaluation {
  return {
    eventType: input?.eventType,
    correlationKey: input?.correlationKey,
    routingDecision: { kind: "stop" },
  };
}

function triggerIgnoreEvaluation(input: {
  reason: "missing_event_type" | "event_not_configured";
  eventType?: string;
  correlationKey?: string;
}): TriggerEvaluation {
  return {
    eventType: input.eventType,
    correlationKey: input.correlationKey,
    routingDecision: {
      kind: "ignore",
      reason: input.reason,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof (value as { then: unknown }).then === "function"
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
    "~standard" in schema &&
    isRecord(schema["~standard"]) &&
    typeof schema["~standard"].validate === "function"
  );
}

function validateTriggerPayload<TPayload extends Record<string, unknown>>(
  schema: TriggerPayloadSchema<TPayload>,
  payload: Record<string, unknown>
): TPayload | undefined {
  if (isSafeParseSchema(schema)) {
    const parsed = schema.safeParse(payload);
    if (!(parsed.success && isRecord(parsed.data))) {
      return;
    }
    return parsed.data;
  }

  if (!isStandardSchema(schema)) {
    return;
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
    return;
  }

  if (!("value" in parsed && isRecord(parsed.value))) {
    return;
  }

  return parsed.value;
}

function runLifecycleHandler<TPayload extends Record<string, unknown>>(input: {
  stage: "start" | "restart" | "stop";
  triggerType: string;
  handler: (input: TriggerLifecycleHandlerInput<TPayload>) => boolean;
  payload: TPayload;
}): boolean {
  try {
    return input.handler({ payload: input.payload });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown lifecycle error";
    throw new Error(
      `Trigger "${input.triggerType}" lifecycle.${input.stage} failed: ${message}`,
      { cause: error }
    );
  }
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
  concurrency: TypedConcurrencyOption<Record<string, unknown>>
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

function extractSchemaKeys(schema: unknown): string[] | undefined {
  if (
    typeof schema === "object" &&
    schema !== null &&
    "shape" in schema &&
    typeof schema.shape === "object" &&
    schema.shape !== null
  ) {
    return Object.keys(schema.shape);
  }
  return undefined;
}

function rewriteCelExpression(
  expression: string,
  schemaKeys: string[] | undefined
): string {
  let ast: CelAstNode;
  try {
    const parsed = parseCel(expression);
    ast = parsed.ast as CelAstNode;
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

function prefixInngestOptions<TPayload extends Record<string, unknown>>(
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

function schemaFieldToOutputField(field: WorkflowSchemaField): OutputField {
  return {
    field: field.name,
    description: field.description ?? field.name,
    type: field.type,
    ...(field.type === "timestamp" ? { format: "timestamp" as const } : {}),
  };
}

function extractStandardSchemaOutputFields(
  schema: TriggerPayloadSchema<Record<string, unknown>>
): OutputField[] | undefined {
  if (!isStandardSchema(schema)) {
    return undefined;
  }

  const standard = schema["~standard"];
  if (
    !(
      isRecord(standard) &&
      "jsonSchema" in standard &&
      isRecord(standard.jsonSchema)
    ) ||
    typeof standard.jsonSchema.input !== "function"
  ) {
    return undefined;
  }

  try {
    const inputFn: unknown = standard.jsonSchema.input;
    if (typeof inputFn !== "function") {
      return undefined;
    }

    const jsonSchema: unknown = inputFn({ target: "draft-2020-12" });
    if (!isRecord(jsonSchema)) {
      return undefined;
    }

    const fields = parseWorkflowSchemaFieldsOrJsonSchema(jsonSchema);
    return fields && fields.length > 0
      ? fields.map(schemaFieldToOutputField)
      : undefined;
  } catch {
    return undefined;
  }
}

function outputFieldsFromTriggerSchema<
  TPayload extends Record<string, unknown>,
>(schema: TriggerPayloadSchema<TPayload>): OutputField[] {
  const standardFields = extractStandardSchemaOutputFields(schema);
  if (standardFields) {
    return standardFields;
  }

  // Fallback: extract top-level field names from Zod .shape
  const schemaKeys = extractSchemaKeys(schema);
  if (schemaKeys && schemaKeys.length > 0) {
    return schemaKeys.map((key) => ({
      field: key,
      description: key,
    }));
  }

  return [];
}

function buildInngestEventTriggerConfig<
  TPayload extends Record<string, unknown>,
>(input: CreateTriggerInputEvent<TPayload>): InngestEventTriggerConfig {
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
    Object.assign(
      functionOptions,
      prefixInngestOptions(input.inngest, input.schema)
    );
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
 * All dot-path fields (`correlationIdPath`, `concurrency.key`, `inngest.*.key`)
 * reference your schema directly -- the `event.data.` prefix required by
 * Inngest is added automatically.
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
 *   concurrency: { limit: 1, key: "appointment.id" },
 *   inngest: {
 *     priority: { run: 'appointment.priority == "high" ? 100 : 50' },
 *   },
 *   lifecycle: {
 *     onStart: ({ payload }) => payload.event === "appointment.created",
 *     onRestart: ({ payload }) => payload.event === "appointment.rescheduled",
 *     onStop: ({ payload }) => payload.event === "appointment.canceled",
 *   },
 * });
 * ```
 */
export function createTrigger<TPayload extends Record<string, unknown>>(
  input: CreateTriggerInput<TPayload>
): RuntimeExtensionTriggerDefinition {
  const triggerType = input.type.trim();
  const label = input.label.trim();
  const correlationIdPath = input.correlationIdPath.trim();

  if (!triggerType) {
    throw new Error("Trigger type must be a non-empty string");
  }

  if (!label) {
    throw new Error("Trigger label must be a non-empty string");
  }

  if (!correlationIdPath) {
    throw new Error("Trigger correlationIdPath must be a non-empty string");
  }

  if (typeof input.lifecycle.onStart !== "function") {
    throw new Error("Trigger lifecycle.onStart must be a function");
  }

  if (typeof input.lifecycle.onRestart !== "function") {
    throw new Error("Trigger lifecycle.onRestart must be a function");
  }

  if (typeof input.lifecycle.onStop !== "function") {
    throw new Error("Trigger lifecycle.onStop must be a function");
  }

  const inngestEventTrigger =
    input.event !== undefined
      ? buildInngestEventTriggerConfig(input)
      : undefined;

  const executionType: TriggerExecutionType = inngestEventTrigger
    ? "event"
    : "webhook";

  let configFields: ActionConfigField[] | undefined;
  if (input.configSchema) {
    const jsonSchema = input.configSchema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    configFields = configFieldsFromJsonSchema(jsonSchema);
  }

  const outputFields = outputFieldsFromTriggerSchema(input.schema);

  const definition = normalizeTriggerDefinition({
    runtime: {
      type: triggerType,
      executionType,
      inngestEventTrigger,
      evaluate({ config: _config, payload }) {
        const validatedPayload = validateTriggerPayload(input.schema, payload);
        if (!validatedPayload) {
          return triggerIgnoreEvaluation({
            reason: "event_not_configured",
          });
        }

        const eventType = undefined;
        const correlationId = asNonEmptyString(
          getValueByPath(validatedPayload, correlationIdPath)
        );

        if (
          runLifecycleHandler({
            stage: "stop",
            triggerType,
            handler: input.lifecycle.onStop,
            payload: validatedPayload,
          })
        ) {
          return triggerStopEvaluation({
            eventType,
            correlationKey: correlationId,
          });
        }

        if (
          runLifecycleHandler({
            stage: "restart",
            triggerType,
            handler: input.lifecycle.onRestart,
            payload: validatedPayload,
          })
        ) {
          return triggerRestartEvaluation({
            eventType,
            correlationKey: correlationId,
          });
        }

        if (
          runLifecycleHandler({
            stage: "start",
            triggerType,
            handler: input.lifecycle.onStart,
            payload: validatedPayload,
          })
        ) {
          return triggerStartEvaluation({
            eventType,
            correlationKey: correlationId,
          });
        }

        return triggerIgnoreEvaluation({
          reason: "event_not_configured",
          eventType,
          correlationKey: correlationId,
        });
      },
    },
    ui: {
      label,
      description: input.description,
      logoUrl: input.logoUrl,
      configFields,
      outputFields: outputFields.length > 0 ? outputFields : undefined,
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

// Built-in triggers ship here. Project-specific triggers should register at
// runtime via `registerWorkflowTrigger(...)` inside `src/backend/workflow-triggers/index.ts`.
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
  payload: Record<string, unknown>;
}): TriggerEvaluation {
  const trigger = resolveWorkflowTriggerDefinition(input.config);
  return trigger.runtime.evaluate(input);
}
