import type { ActionConfigField, OutputField } from "@/plugins/registry";

type ActionSchemaSafeParseResult<TPayload> =
  | { success: true; data: TPayload }
  | { success: false; error?: unknown };

type ActionSchemaSafeParse<TPayload> = {
  safeParse: (value: unknown) => ActionSchemaSafeParseResult<TPayload>;
};

type ActionSchemaStandardSuccess<TPayload> = {
  value: TPayload;
  issues?: undefined;
};

type ActionSchemaStandardFailure = {
  issues: ReadonlyArray<{
    message: string;
    path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
  }>;
};

type ActionSchemaStandardResult<TPayload> =
  | ActionSchemaStandardSuccess<TPayload>
  | ActionSchemaStandardFailure;

type ActionSchemaStandard<TPayload> = {
  "~standard": {
    validate: (
      value: unknown
    ) =>
      | ActionSchemaStandardResult<TPayload>
      | Promise<ActionSchemaStandardResult<TPayload>>;
  };
};

export type ActionPayloadSchema<TPayload> =
  | ActionSchemaSafeParse<TPayload>
  | ActionSchemaStandard<TPayload>;

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
  "execute"
> & {
  /**
   * Zod or Standard Schema that validates the resolved config values
   * before they reach your `execute` function. If validation fails,
   * the action returns a structured error automatically.
   */
  schema: ActionPayloadSchema<TPayload>;

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

function isSafeParseSchema<TPayload>(
  schema: ActionPayloadSchema<TPayload>
): schema is ActionSchemaSafeParse<TPayload> {
  return "safeParse" in schema && typeof schema.safeParse === "function";
}

function isStandardSchema<TPayload>(
  schema: ActionPayloadSchema<TPayload>
): schema is ActionSchemaStandard<TPayload> {
  return (
    isRecord(schema) &&
    "~standard" in schema &&
    isRecord(schema["~standard"]) &&
    typeof schema["~standard"].validate === "function"
  );
}

function validateActionPayload<TPayload extends Record<string, unknown>>(
  schema: ActionPayloadSchema<TPayload>,
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
 *   configFields: [
 *     { key: "appointmentId", label: "Appointment ID", type: "template-input", required: true },
 *     { key: "reason", label: "Reason", type: "template-textarea", required: true },
 *   ],
 *   outputFields: [
 *     { field: "appointmentId", description: "Cancelled appointment ID" },
 *     { field: "status", description: "Cancellation status" },
 *   ],
 *   schema: z.object({
 *     appointmentId: z.string(),
 *     reason: z.string().min(1),
 *   }),
 *   execute({ payload }) {
 *     return { success: true, data: { appointmentId: payload.appointmentId, status: "cancelled" } };
 *   },
 * });
 * ```
 */
export function createAction<TPayload extends Record<string, unknown>>(
  input: CreateActionInput<TPayload>
): RuntimeExtensionActionDefinition {
  const normalizedDefinition = normalizeRuntimeActionDefinition({
    ...input,
    execute: async ({ payload, context }) => {
      const validatedPayload = validateActionPayload(input.schema, payload);
      if (!validatedPayload) {
        return {
          success: false,
          error: {
            message: `Action "${input.id}" received an invalid payload.`,
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
