import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import type {
  ActionConfigField,
  ActionConfigFieldBase,
  OutputField,
} from "@/plugins/registry";
import type { WorkflowSchemaField } from "@/workflow/schema-codec";
import {
  configFieldsFromJsonSchema,
  parseWorkflowSchemaFieldsOrJsonSchema,
} from "@/workflow/schema-codec";

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

export type RuntimeActionResult =
  | { success: true; data?: unknown }
  | { success: false; error?: string | { message?: string } };

export type RuntimeActionDefinition = {
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
  outputFields?: OutputField[];

  execute: (
    input: RuntimeActionExecuteInput
  ) => RuntimeActionResult | Promise<RuntimeActionResult>;
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
  | { success: false; error?: string | { message?: string } };

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
  outputFields?: OutputField[];
  execute: (input: {
    payload: TPayload;
    context: RuntimeActionExecutionContext;
  }) => TypedActionResult<TOutput> | Promise<TypedActionResult<TOutput>>;
};

export type RuntimeActionMetadata = Omit<RuntimeActionDefinition, "execute">;

const runtimeActionRegistry = new Map<string, RuntimeActionDefinition>();

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
    return;
  }

  if (!("value" in parsed && isRecord(parsed.value))) {
    return;
  }

  return parsed.value;
}

function configFieldsFromInputSchema(
  schema: InputSchema<Record<string, unknown>>
): ActionConfigFieldBase[] {
  const jsonSchema = schema["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  });
  return configFieldsFromJsonSchema(jsonSchema);
}

function normalizeRuntimeActionDefinition(
  definition: RuntimeActionDefinition
): RuntimeActionDefinition {
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

function schemaFieldToOutputField(field: WorkflowSchemaField): OutputField {
  return {
    field: field.name,
    description: field.description ?? field.name,
    type: field.type,
    ...(field.type === "timestamp" ? { format: "timestamp" as const } : {}),
  };
}

function outputFieldsFromStandardSchema(
  schema: OutputSchema<Record<string, unknown>>
): OutputField[] {
  const jsonSchema = schema["~standard"].jsonSchema.output({
    target: "draft-2020-12",
  });
  const fields = parseWorkflowSchemaFieldsOrJsonSchema(jsonSchema);
  if (fields) {
    return fields.map(schemaFieldToOutputField);
  }
  return [];
}

function mergeOutputFields(
  derived: OutputField[],
  manual: OutputField[]
): OutputField[] {
  const merged = new Map<string, OutputField>();
  for (const field of derived) {
    merged.set(field.field, field);
  }
  for (const field of manual) {
    merged.set(field.field, field);
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
  const derivedConfigFields = configFieldsFromInputSchema(
    input.schema as InputSchema<Record<string, unknown>>
  );

  let resolvedOutputFields = input.outputFields;
  if ("outputSchema" in input && input.outputSchema) {
    const derived = outputFieldsFromStandardSchema(input.outputSchema);
    resolvedOutputFields = input.outputFields
      ? mergeOutputFields(derived, input.outputFields)
      : derived;
  }

  const normalizedDefinition = normalizeRuntimeActionDefinition({
    ...input,
    configFields: derivedConfigFields,
    outputFields: resolvedOutputFields,
    execute: async ({ payload, context }) => {
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
    },
  });

  return {
    ...normalizedDefinition,
    __runtimeExtensionActionBrand: true,
  };
}

export function registerRuntimeAction(
  definition: RuntimeActionDefinition
): void {
  const normalizedDefinition = normalizeRuntimeActionDefinition(definition);
  runtimeActionRegistry.set(normalizedDefinition.id, normalizedDefinition);
}

export function unregisterRuntimeAction(actionId: string): void {
  const normalizedId = actionId.trim();
  if (!normalizedId) {
    return;
  }
  runtimeActionRegistry.delete(normalizedId);
}

export function getRuntimeAction(
  actionId: string
): RuntimeActionDefinition | undefined {
  return runtimeActionRegistry.get(actionId);
}

export function listRuntimeActions(): RuntimeActionMetadata[] {
  return Array.from(runtimeActionRegistry.values()).map(
    ({ execute: _execute, ...metadata }) => metadata
  );
}
