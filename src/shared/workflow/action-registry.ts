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
  id: string;
  label: string;
  description: string;
  category?: string;
  logoUrl?: string;
  configFields?: ActionConfigField[];
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
  schema: ActionPayloadSchema<TPayload>;
  execute: (input: {
    payload: TPayload;
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
