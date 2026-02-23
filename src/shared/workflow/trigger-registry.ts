import type { ActionConfigField } from "@/plugins/registry";
import { getValueByPath } from "@/shared/utils/object-path";
import {
  createDefaultTriggerDefinition,
  createUnknownTriggerDefinition,
} from "@/shared/workflow/triggers/fallback-trigger";
import { createScheduleTriggerDefinition } from "@/shared/workflow/triggers/schedule-trigger";
import { createWebhookTriggerDefinition } from "@/shared/workflow/triggers/webhook-trigger";
import { asNonEmptyString } from "@/shared/workflow/webhook-routing";

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

export type InngestConcurrencyOption =
  | number
  | { limit: number; key?: string; scope?: "fn" | "env" | "account" }
  | Array<{ limit: number; key?: string; scope?: "fn" | "env" | "account" }>;

export type InngestFunctionOptions = {
  rateLimit?: { limit: number; period: string; key?: string };
  throttle?: { limit: number; period: string; key?: string; burst?: number };
  debounce?: { period: string; key?: string; timeout?: string };
  priority?: { run: string };
  timeouts?: { start?: string; finish?: string };
  retries?: number;
  cancelOn?: Array<{ event: string; if?: string; timeout?: string }>;
  [key: string]: unknown;
};

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
};

export type WorkflowTriggerDefinition = {
  runtime: WorkflowTriggerRuntimeDefinition;
  ui: WorkflowTriggerUiDefinition;
};

export type RuntimeExtensionTriggerDefinition = WorkflowTriggerDefinition & {
  readonly __runtimeExtensionTriggerBrand: true;
};

type CreateTriggerInputBase<TPayload extends Record<string, unknown>> = {
  type: string;
  label: string;
  schema: TriggerPayloadSchema<TPayload>;
  correlationIdPath: TriggerStringPath<TPayload>;
  lifecycle: TriggerLifecycleInput<TPayload>;
  description?: string;
  logoUrl?: string;
  configFields?: ActionConfigField[];
};

type CreateTriggerInputWebhook<TPayload extends Record<string, unknown>> =
  CreateTriggerInputBase<TPayload> & {
    event?: undefined;
    idempotency?: never;
    concurrency?: never;
    inngest?: never;
  };

type CreateTriggerInputEvent<TPayload extends Record<string, unknown>> =
  CreateTriggerInputBase<TPayload> & {
    event: string | string[];
    idempotency?: string;
    concurrency?: InngestConcurrencyOption;
    inngest?: InngestFunctionOptions;
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
  return (
    isRecord(schema) &&
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

function buildInngestEventTriggerConfig(
  input: CreateTriggerInputEvent<Record<string, unknown>>
): InngestEventTriggerConfig {
  const rawEvents = Array.isArray(input.event) ? input.event : [input.event];
  const eventNames = rawEvents.map((e) => e.trim());

  for (const name of eventNames) {
    if (!name) {
      throw new Error("Trigger event names must be non-empty strings");
    }
  }

  const functionOptions: Record<string, unknown> = {};

  if (input.idempotency !== undefined) {
    functionOptions.idempotency = input.idempotency;
  }

  if (input.concurrency !== undefined) {
    functionOptions.concurrency = input.concurrency;
  }

  if (input.inngest !== undefined) {
    if ("batchEvents" in input.inngest) {
      throw new Error(
        "batchEvents is not supported — it changes the handler signature and is incompatible with event listener triggers"
      );
    }
    Object.assign(functionOptions, input.inngest);
  }

  return { eventNames, functionOptions };
}

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
      ? buildInngestEventTriggerConfig(
          input as CreateTriggerInputEvent<Record<string, unknown>>
        )
      : undefined;

  const executionType: TriggerExecutionType = inngestEventTrigger
    ? "event"
    : "webhook";

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
      configFields: input.configFields,
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
