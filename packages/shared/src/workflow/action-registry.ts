import { Result, Schema } from "effect";
import type {
  ActionConfigField,
  ActionConfigFieldBase,
} from "#src/plugins/action-fields";
import { formatSchemaFailure } from "#src/types/schema-message";
import {
  asStandardSchema,
  isEffectSchema,
  type StandardSchema,
} from "#src/types/schema";
import type { ReferenceField } from "#src/workflow/node-references";
import {
  type OutputSchema,
  outputFieldsFromSchema,
} from "#src/workflow/output-fields";
import {
  configFieldsFromJsonSchema,
  jsonSchemaLibraryOptions,
} from "#src/workflow/schema-codec";
import type { StepError, StepResult } from "#src/workflow/step-result";

/**
 * What `schema` in `createAction` accepts, in either of the two forms a schema
 * arrives in.
 *
 * Both halves of Standard Schema are needed from one object: resolved config
 * values are validated with `~standard.validate`, and `configFields` is derived
 * from `~standard.jsonSchema.input()`. Zod v4 and arktype hand over an object
 * carrying both, and that is the first arm.
 *
 * The second arm is a bare Effect schema, which carries neither until it is
 * asked to. `createAction` asks, once, so an author writes
 * `schema: Schema.Struct({ ... })` and nothing else.
 */
export type InputSchema<TPayload> =
  | StandardSchema<TPayload>
  | Schema.ConstraintDecoder<TPayload>;

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
 * What a host action's `execute` resolves to. It is the wrapper every other step
 * returns, so the engine runs a host's action and an integration's step the same
 * way.
 */
export type RuntimeActionResult = StepResult;

export type RuntimeActionMetadata = {
  /**
   * Unique identifier in `"category/slug"` format (e.g. `"appointments/cancel"`).
   * The engine dispatches on it, and it is what a saved node stores.
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

/**
 * What `createAction` hands back: a definition with everything filled in.
 *
 * `category` is no longer optional, because the default has been applied by the
 * time a value of this type exists, and assembly copies it into the catalog
 * without deciding anything of its own.
 */
export type RuntimeExtensionActionDefinition = RuntimeActionDefinition & {
  readonly category: string;
  readonly __runtimeExtensionActionBrand: true;
};

export type CreateActionInput<TPayload extends Record<string, unknown>> = Omit<
  RuntimeActionDefinition,
  "execute" | "configFields"
> & {
  /**
   * The schema that validates the resolved config values before they reach
   * your `execute` function. Write it in Effect Schema, Zod, or arktype --
   * whichever, it is passed as it is, with no wrapping.
   *
   * `configFields` are auto-derived from the schema's JSON Schema
   * representation. A field's human-readable label comes from its
   * `description`: an annotation in Effect Schema, `.describe()` in Zod.
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

export type CreateActionInputWithOutput<
  TPayload extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
> = Omit<
  RuntimeActionDefinition,
  "execute" | "configFields" | "outputFields"
> & {
  schema: InputSchema<TPayload>;
  /**
   * The schema describing what `execute` resolves to. Auto-derives
   * `outputFields` via `~standard.jsonSchema.output()` and types the return.
   */
  outputSchema: OutputSchema<TOutput>;
  /** Manual overrides merged on top of auto-derived output fields. */
  outputFields?: ReferenceField[];
  execute: (input: {
    payload: TPayload;
    context: RuntimeActionExecutionContext;
  }) => TypedActionResult<TOutput> | Promise<TypedActionResult<TOutput>>;
};

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function validateActionPayload<TPayload extends Record<string, unknown>>(
  schema: StandardSchema<TPayload>,
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
  schema: StandardSchema<Record<string, unknown>>
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

/**
 * The encode a host action's answer passes through on its way out.
 *
 * A step result is memoized by the durable runtime and stored as a node output,
 * so it has to be JSON, and the output schema is the only thing that knows what
 * this action returns. Encoding through the canonical JSON codec is what turns a
 * `Date` or an `Option` into JSON rather than leaving it to survive by accident
 * through `Date.prototype.toJSON` and come back a string on the replay.
 *
 * Only an Effect schema has an encoder: a Standard Schema library hands over a
 * validator and a JSON Schema and nothing that runs in this direction. Those
 * pass through untouched, which is the same call `output-fields.ts` makes for
 * the field list -- what the schema cannot say about itself is not said.
 */
function outputEncoder(
  schema: OutputSchema<Record<string, unknown>>
):
  | ((value: unknown) => Result.Result<unknown, Schema.SchemaError>)
  | undefined {
  if (!isEffectSchema<Record<string, unknown>, never>(schema)) {
    return undefined;
  }

  // `errors: "all"` is what `formatSchemaFailure` is written against: it counts
  // the issues it does not spell out, and stopping at the first would make that
  // count always zero.
  return Schema.encodeUnknownResult(Schema.toCodecJson(schema), {
    errors: "all",
  });
}

/**
 * The payload of a successful result, encoded, or the node failed once.
 *
 * A handler answering with something its output schema cannot encode will answer
 * with it again on every attempt, so this fails rather than spending the retry
 * budget on a certainty. `defineStep` treats the same mistake the same way.
 */
function encodeResult(
  actionId: string,
  encode: (value: unknown) => Result.Result<unknown, Schema.SchemaError>,
  result: RuntimeActionResult
): RuntimeActionResult {
  if (!result.success) {
    return result;
  }

  const encoded = encode(result.data);
  if (Result.isFailure(encoded)) {
    return {
      success: false,
      error: {
        message: `Action "${actionId}" returned a value its output schema cannot encode: ${formatSchemaFailure(encoded.failure.issue)}`,
      },
    };
  }

  return { success: true, data: encoded.success };
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
 * Create a typed action definition, for `createRovaApp({ extensions: { actions } })`.
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
 *   schema: Schema.Struct({
 *     appointmentId: Schema.String.annotate({ description: "Appointment ID" }),
 *     reason: Schema.String.annotate({
 *       description: "Cancellation reason",
 *     }).check(Schema.isMinLength(1)),
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
  // The one place a schema is bridged. Everything below reads Standard Schema
  // and nothing below knows which library wrote what it is reading.
  const schema = asStandardSchema(input.schema);
  const derivedConfigFields = configFieldsFromInputSchema(schema);

  let resolvedOutputFields = input.outputFields;
  let encodeOutput:
    | ((value: unknown) => Result.Result<unknown, Schema.SchemaError>)
    | undefined;
  if ("outputSchema" in input && input.outputSchema) {
    const derived = outputFieldsFromSchema(input.outputSchema);
    resolvedOutputFields = input.outputFields
      ? mergeOutputFields(derived, input.outputFields)
      : derived;
    encodeOutput = outputEncoder(input.outputSchema);
  }

  const execute: RuntimeActionExecute = async ({ payload, context }) => {
    const validatedPayload = validateActionPayload(schema, payload);
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
      const result = await input.execute({
        payload: validatedPayload,
        context,
      });
      return encodeOutput
        ? encodeResult(input.id, encodeOutput, result)
        : result;
    } catch (error) {
      return {
        success: false,
        error: {
          message: getActionErrorMessage(error),
        },
      };
    }
  };

  // Named rather than spread, so the schemas stay behind. Everything they had
  // to say has been said, into `configFields`, `outputFields` and the `execute`
  // above, and what assembly copies into the catalog is what /api/extensions
  // serializes to the browser -- where a schema object is a dump of one library's
  // internals or nothing at all, depending on who wrote it.
  const normalized = normalizeRuntimeActionMetadata({
    id: input.id,
    label: input.label,
    description: input.description,
    category: input.category,
    logoUrl: input.logoUrl,
    configFields: derivedConfigFields,
    outputFields: resolvedOutputFields,
  });

  return {
    ...normalized,
    execute,
    __runtimeExtensionActionBrand: true,
  };
}
