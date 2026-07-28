import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import type {
  ActionConfigField,
  ActionConfigFieldBase,
} from "#src/plugins/registry";
import type { IntegrationType } from "#src/types/integration";
import {
  type ReferenceField,
  schemaFieldToReferenceField,
} from "#src/workflow/node-references";
import {
  configFieldsFromJsonSchema,
  jsonSchemaLibraryOptions,
  parseWorkflowSchemaFieldsOrJsonSchema,
} from "#src/workflow/schema-codec";
import type { StepError, StepResult } from "#src/workflow/step-result";

/**
 * A Standard Schema that supports both validation and JSON Schema generation.
 * Zod v4 and arktype satisfy this interface.
 *
 * Used for `schema` in `createAction` so the framework can:
 * 1. Validate resolved config values at runtime (`~standard.validate`)
 * 2. Derive `configFields` from `~standard.jsonSchema.input()` at registration
 */
export type InputSchema<TPayload> = {
  readonly "~standard": StandardSchemaV1.Props<unknown, TPayload> & {
    readonly jsonSchema: StandardJSONSchemaV1.Converter;
  };
};

export type RuntimeActionExecutionContext = {
  executionId?: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  integrationId?: string;
};

export type RuntimeActionExecuteInput = {
  payload: Record<string, unknown>;
  context: RuntimeActionExecutionContext;
};

/**
 * What a runtime action's `execute` resolves to. A runtime action answers with
 * the same wrapper every other step returns, so the engine handles a runtime
 * action and a plugin step identically.
 */
export type RuntimeActionResult = StepResult;

export type RuntimeActionMetadata = {
  /**
   * Unique identifier in `"category/slug"` format (e.g. `"appointments/cancel"`).
   * Used internally to dispatch execution and register the action.
   */
  id: string;

  /** Human-readable name shown in the action selector (e.g. `"Cancel Appointment"`). */
  label: string;

  /** Short description shown beneath the action label in the editor. */
  description: string;

  /**
   * Grouping category in the action selector (e.g. `"Appointments"`).
   * Defaults to `"Custom"` if omitted.
   */
  category?: string;

  /** Optional URL to a logo/icon displayed next to the action in the editor. */
  logoUrl?: string;

  /**
   * Declarative field definitions rendered as the action's configuration form.
   * Each field maps to a key in the action's config object. Supported types
   * include `"template-input"`, `"template-textarea"`, `"text"`, `"number"`,
   * `"select"`, `"schema-builder"`, and `"key-value"`.
   */
  configFields?: ActionConfigField[];

  /**
   * Describes the fields available in this action's output for downstream
   * template autocomplete (e.g. `{{ @NodeLabel.appointmentId }}`).
   * Field paths should not include the `data.` prefix -- they are unwrapped automatically.
   */
  outputFields?: ReferenceField[];
};

export type RuntimeActionExecute = (
  input: RuntimeActionExecuteInput
) => RuntimeActionResult | Promise<RuntimeActionResult>;

/** What a host writes: metadata plus the implementation. */
export type RuntimeActionDefinition = RuntimeActionMetadata & {
  execute: RuntimeActionExecute;
};

export type RuntimeExtensionActionDefinition = RuntimeActionDefinition & {
  readonly __runtimeExtensionActionBrand: true;
};

export type CreateActionInput<TPayload extends Record<string, unknown>> = Omit<
  RuntimeActionDefinition,
  "execute" | "configFields"
> & {
  /**
   * Standard Schema that validates the resolved config values before they
   * reach your `execute` function. Must support both `~standard.validate`
   * (runtime validation) and `~standard.jsonSchema` (configFields derivation).
   * Zod v4 satisfies this interface.
   *
   * `configFields` are auto-derived from the schema's JSON Schema representation.
   * Use `.describe()` on schema fields to set human-readable labels.
   */
  schema: InputSchema<TPayload>;

  /**
   * Action implementation. Receives the validated `payload` (config values
   * after template resolution) and an execution `context` with metadata
   * like `executionId`, `nodeId`, and `integrationId`.
   *
   * Return `{ success: true, data: { ... } }` on success or
   * `{ success: false, error: { message: "..." } }` on failure.
   * Thrown exceptions are caught and wrapped in the error format automatically.
   */
  execute: (input: {
    /** Config values validated against `schema`. */
    payload: TPayload;
    /** Execution metadata (IDs, integration reference). */
    context: RuntimeActionExecutionContext;
  }) => RuntimeActionResult | Promise<RuntimeActionResult>;
};

/** Typed success result when outputSchema is provided. */
export type TypedActionResult<TOutput extends Record<string, unknown>> =
  | { success: true; data: TOutput }
  | { success: false; error: StepError };

/**
 * A Standard Schema that also implements the JSON Schema interface
 * (`StandardJSONSchemaV1`). Both arktype and Zod v4 satisfy this.
 *
 * Used for `outputSchema` so `createAction` can:
 * 1. Infer `TOutput` from the schema's output type (compile-time)
 * 2. Call `~standard.jsonSchema.output()` to derive `outputFields` (runtime)
 */
export type OutputSchema<TOutput> = StandardJSONSchemaV1<unknown, TOutput>;

export type CreateActionInputWithOutput<
  TPayload extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
> = Omit<
  RuntimeActionDefinition,
  "execute" | "configFields" | "outputFields"
> & {
  schema: InputSchema<TPayload>;
  /**
   * Standard Schema with JSON Schema support. Auto-derives `outputFields`
   * via `~standard.jsonSchema.output()` and types the `execute` return.
   */
  outputSchema: OutputSchema<TOutput>;
  /** Manual overrides merged on top of auto-derived output fields. */
  outputFields?: ReferenceField[];
  execute: (input: {
    payload: TPayload;
    context: RuntimeActionExecutionContext;
  }) => TypedActionResult<TOutput> | Promise<TypedActionResult<TOutput>>;
};

/**
 * What the registry holds.
 *
 * The server registers actions it can run; the browser registers the same
 * actions as metadata, arriving over /api/extensions with no `execute` to send.
 * They differ in what they put in, not in which registry they put it in.
 */
export type RegisteredRuntimeAction = RuntimeActionMetadata & {
  /** Defaulted at registration, so readers never have to. */
  category: string;
  /** Set when the action came from a plugin, never by `createAction`. */
  integration?: IntegrationType;
  execute?: RuntimeActionExecute;
};

/** What `/api/extensions` sends: what the editor draws from, minus what cannot serialize. */
export type RuntimeActionWireMetadata = Omit<
  RegisteredRuntimeAction,
  "execute"
>;

// Symbol.for on globalThis, so the registry stays one map even when this module
// is duplicated across bundles: the @rova/core build inlines @rova/shared while
// @rova/plugins imports it separately.
// eslint-disable-next-line typescript/no-unsafe-type-assertion -- cross-bundle singleton via Symbol.for
const globalStore = globalThis as Record<symbol, unknown>;
const registryKey = Symbol.for("@rova/runtime-action-registry");

globalStore[registryKey] ??= {
  actions: new Map<string, RegisteredRuntimeAction>(),
  version: 0,
};

// eslint-disable-next-line typescript/no-unsafe-type-assertion -- initialized above
const registryState = globalStore[registryKey] as {
  actions: Map<string, RegisteredRuntimeAction>;
  version: number;
};

const runtimeActionRegistry = registryState.actions;

/**
 * Bumped on every write. Anything caching a view of this registry compares the
 * number it last saw, which is what keeps a cached lookup from outliving the
 * action it described.
 */
export function getRuntimeActionRegistryVersion(): number {
  return registryState.version;
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function validateActionPayload<TPayload extends Record<string, unknown>>(
  schema: InputSchema<TPayload>,
  payload: Record<string, unknown>
): TPayload | undefined {
  const parsed = schema["~standard"].validate(payload);

  if (isPromiseLike(parsed)) {
    throw new Error(
      "Action schema validation must be synchronous. Async Standard Schema validators are not supported."
    );
  }

  if (
    "issues" in parsed &&
    Array.isArray(parsed.issues) &&
    parsed.issues.length > 0
  ) {
    return undefined;
  }

  if (!("value" in parsed)) {
    return undefined;
  }

  return parsed.value;
}

function configFieldsFromInputSchema(
  schema: InputSchema<Record<string, unknown>>
): ActionConfigFieldBase[] {
  try {
    const jsonSchema = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
      libraryOptions: jsonSchemaLibraryOptions,
    });
    return configFieldsFromJsonSchema(jsonSchema);
  } catch {
    return [];
  }
}

function normalizeRuntimeActionMetadata(
  definition: RuntimeActionMetadata
): RuntimeActionMetadata & { category: string } {
  const actionId = definition.id.trim();
  const label = definition.label.trim();
  const description = definition.description.trim();

  if (!actionId) {
    throw new Error("Action id must be a non-empty string");
  }

  if (!label) {
    throw new Error("Action label must be a non-empty string");
  }

  if (!description) {
    throw new Error("Action description must be a non-empty string");
  }

  const logoUrl = definition.logoUrl?.trim();

  return {
    ...definition,
    id: actionId,
    label,
    description,
    category: definition.category?.trim() || "Custom",
    logoUrl: logoUrl || undefined,
  };
}

function getActionErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Action execution failed";
}

function outputFieldsFromStandardSchema(
  schema: OutputSchema<Record<string, unknown>>
): ReferenceField[] {
  let jsonSchema: Record<string, unknown>;
  try {
    jsonSchema = schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
      libraryOptions: jsonSchemaLibraryOptions,
    });
  } catch {
    try {
      jsonSchema = schema["~standard"].jsonSchema.input({
        target: "draft-2020-12",
        libraryOptions: jsonSchemaLibraryOptions,
      });
    } catch {
      return [];
    }
  }
  const fields = parseWorkflowSchemaFieldsOrJsonSchema(jsonSchema);
  if (fields) {
    return fields.map((field) => schemaFieldToReferenceField(field));
  }
  return [];
}

function mergeOutputFields(
  derived: ReferenceField[],
  manual: ReferenceField[]
): ReferenceField[] {
  const merged = new Map<string, ReferenceField>();
  for (const field of derived) {
    merged.set(field.path, field);
  }
  for (const field of manual) {
    merged.set(field.path, field);
  }
  return Array.from(merged.values());
}

/**
 * Create a typed action definition for use with `server.start({ actions })`.
 *
 * Actions are the executable steps in a workflow. When a workflow reaches
 * an action node, the engine resolves template variables in the config,
 * validates the result against `schema`, and calls `execute` with the
 * typed payload.
 *
 * @example
 * ```ts
 * const action = createAction({
 *   id: "appointments/cancel",
 *   label: "Cancel Appointment",
 *   description: "Cancels an appointment and records the reason.",
 *   category: "Appointments",
 *   schema: z.object({
 *     appointmentId: z.string().describe("Appointment ID"),
 *     reason: z.string().min(1).describe("Cancellation reason"),
 *   }),
 *   execute({ payload }) {
 *     return { success: true, data: { appointmentId: payload.appointmentId, status: "cancelled" } };
 *   },
 * });
 * ```
 */
export function createAction<
  TPayload extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
>(
  input: CreateActionInputWithOutput<TPayload, TOutput>
): RuntimeExtensionActionDefinition;
export function createAction<TPayload extends Record<string, unknown>>(
  input: CreateActionInput<TPayload>
): RuntimeExtensionActionDefinition;
export function createAction<TPayload extends Record<string, unknown>>(
  input:
    | CreateActionInput<TPayload>
    | CreateActionInputWithOutput<TPayload, Record<string, unknown>>
): RuntimeExtensionActionDefinition {
  const derivedConfigFields = configFieldsFromInputSchema(input.schema);

  let resolvedOutputFields = input.outputFields;
  if ("outputSchema" in input && input.outputSchema) {
    const derived = outputFieldsFromStandardSchema(input.outputSchema);
    resolvedOutputFields = input.outputFields
      ? mergeOutputFields(derived, input.outputFields)
      : derived;
  }

  const execute: RuntimeActionExecute = async ({ payload, context }) => {
    const validatedPayload = validateActionPayload(input.schema, payload);
    if (!validatedPayload) {
      const payloadKeys = Object.keys(payload);
      return {
        success: false,
        error: {
          message: `Action "${input.id}" received an invalid payload. Payload keys: [${payloadKeys.join(", ")}]`,
        },
      };
    }

    try {
      return await input.execute({ payload: validatedPayload, context });
    } catch (error) {
      return {
        success: false,
        error: {
          message: getActionErrorMessage(error),
        },
      };
    }
  };

  const normalized = normalizeRuntimeActionMetadata({
    ...input,
    configFields: derivedConfigFields,
    outputFields: resolvedOutputFields,
  });

  return {
    ...normalized,
    execute,
    __runtimeExtensionActionBrand: true,
  };
}

export function registerRuntimeAction(
  definition: RuntimeActionMetadata & {
    integration?: IntegrationType;
    execute?: RuntimeActionExecute;
  }
): void {
  const { execute, integration, ...metadata } = definition;
  const normalized = normalizeRuntimeActionMetadata(metadata);

  runtimeActionRegistry.set(normalized.id, {
    ...normalized,
    ...(integration ? { integration } : {}),
    ...(execute ? { execute } : {}),
  });
  registryState.version += 1;
}

export function unregisterRuntimeAction(actionId: string): void {
  const normalizedId = actionId.trim();
  if (!normalizedId) {
    return;
  }
  runtimeActionRegistry.delete(normalizedId);
  registryState.version += 1;
}

export function getRuntimeAction(
  actionId: string
): RegisteredRuntimeAction | undefined {
  return runtimeActionRegistry.get(actionId);
}

export function getRuntimeActions(): RegisteredRuntimeAction[] {
  return Array.from(runtimeActionRegistry.values());
}

export function clearRuntimeActions(): void {
  runtimeActionRegistry.clear();
  registryState.version += 1;
}

export function listRuntimeActions(): RuntimeActionWireMetadata[] {
  return Array.from(runtimeActionRegistry.values()).map(
    ({ execute: _execute, ...metadata }) => metadata
  );
}
