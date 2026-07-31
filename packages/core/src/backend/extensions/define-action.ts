/**
 * How a host writes an action of its own.
 *
 * The step half of the same vocabulary is `defineStep`, and the two read alike on
 * purpose: `input`, `output`, `handler`, and everything around the handler owned
 * here. They differ where they have to. A step's handler is an `Effect` and is
 * handed an integration's credentials; an action's is a plain function or a
 * Promise and belongs to no integration, and its schemas may come from any
 * Standard Schema library rather than from Effect alone.
 *
 * This is server code. It runs the host's `handler`, catches its throws, encodes
 * what it answered, and builds the `StepResult` envelope the engine reads, so it
 * lives beside assembly rather than in the shared package the browser also pulls
 * from.
 */

import { Result } from "effect";
import {
  readIntegrationId,
  readStepContext,
  stripInternalFields,
} from "#src/backend/extensions/steps/step-handler";
import { encodeThroughOutputSchema } from "#src/backend/extensions/steps/output-encoding";
import type { StepFactory } from "#src/backend/extensions/steps/step-runner";
import type { ActionConfigField } from "@rova/shared/plugins/action-fields";
import {
  configFieldsFromInputSchema,
  type InputSchema,
  validateConfig,
} from "#src/backend/extensions/schema-io";
import { getErrorMessage } from "@rova/shared/utils";
import {
  asStandardSchema,
  isEffectSchema,
  type StandardSchema,
} from "@rova/shared/types/schema";
import type { ReferenceField } from "@rova/shared/graph/node-references";
import {
  type OutputSchema,
  outputFieldsFromSchema,
} from "@rova/shared/graph/output-fields";
import type { StepResult } from "@rova/shared/actions/step-result";

/**
 * What the handler is told about the run it is part of.
 *
 * The step half calls this `StepRunContext` and carries the same fields, less
 * the credentials an action has no integration to read.
 */
export type ActionRunContext = {
  /** `"test"` when the editor is running the workflow, `"live"` otherwise. */
  readonly runMode: "live" | "test";
  readonly executionId?: string;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly nodeType: string;
  /** The integration the node was configured with, if any. */
  readonly integrationId?: string;
};

/** What a host writes to describe an action's identity and presentation. */
export type ActionIdentity = {
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
};

/**
 * What `defineAction` hands back: identity, the fields derived from its schemas,
 * and the implementation, everything filled in.
 *
 * `category` is no longer optional, because the default has been applied by the
 * time a value of this type exists, and assembly copies it into the catalog
 * without deciding anything of its own.
 */
export type ActionDefinition = ActionIdentity & {
  readonly category: string;

  /**
   * Declarative field definitions rendered as the action's configuration form,
   * derived from `input`. Each field maps to a key in the action's config
   * object. Supported types include `"template-input"`, `"template-textarea"`,
   * `"text"`, `"number"`, `"select"`, `"schema-builder"`, and `"key-value"`.
   */
  readonly configFields: ActionConfigField[];

  /**
   * Describes the fields available in this action's output for downstream
   * template autocomplete (e.g. `{{ @NodeLabel.appointmentId }}`), derived from
   * `output`. Field paths should not include the `data.` prefix -- they are
   * unwrapped automatically. Absent when `defineAction` was given no `output`,
   * which leaves the action addressable by node but not by field.
   */
  readonly outputFields?: ReferenceField[];

  /**
   * The engine's entry point, in the shape `stepFor` answers with.
   *
   * A step's is a function of the action id, because an integration names its
   * actions and the step never sees the id until assembly. An action carries its
   * own id, so this is the factory itself.
   */
  readonly implement: StepFactory;
  readonly __rovaActionBrand: true;
};

/**
 * The handler, in the two forms an author writes it.
 *
 * It answers the payload rather than an envelope: `defineAction` builds the
 * `{ success, data }` wrapper the engine reads, the same way `defineStep` does.
 * To fail the node, throw -- the message becomes the run log's sentence.
 */
type ActionHandler<TPayload, TOutput> = (input: {
  /** Config values validated against `input`. */
  payload: TPayload;
  /** Which node, which run, and which connection this is running as. */
  context: ActionRunContext;
}) => TOutput | Promise<TOutput>;

export type DefineActionInput<TPayload extends Record<string, unknown>> =
  ActionIdentity & {
    /**
     * The schema that validates the resolved config values before they reach
     * your handler. Write it in Effect Schema, Zod, or arktype -- whichever, it
     * is passed as it is, with no wrapping.
     *
     * `configFields` are auto-derived from the schema's JSON Schema
     * representation. A field's human-readable label comes from its
     * `description`: an annotation in Effect Schema, `.describe()` in Zod.
     */
    input: InputSchema<TPayload>;

    /**
     * Where the work is. An action with no `output` is addressable by node and
     * not by field, so what this answers is passed on untyped and unencoded.
     */
    handler: ActionHandler<TPayload, unknown>;
  };

export type DefineActionInputWithOutput<
  TPayload extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
> = ActionIdentity & {
  input: InputSchema<TPayload>;
  /**
   * The schema describing what the handler answers with. Auto-derives
   * `outputFields` via `~standard.jsonSchema.output()` and types the return.
   */
  output: OutputSchema<TOutput>;
  handler: ActionHandler<TPayload, TOutput>;
};

function normalizeActionIdentity(
  definition: ActionIdentity
): ActionIdentity & { category: string } {
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

/**
 * What an action's throw becomes on the node's run-log row.
 *
 * The shared reader is used because a handler's throw is often a seam failure
 * whose own `.message` is empty -- every `Schema.TaggedErrorClass` in the
 * backend is one -- and a row closed with that alone is a red node with no
 * sentence beside it.
 */
function getActionErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);
  return message === "Unknown error" ? "Action execution failed" : message;
}

/**
 * Everything an action does around its handler, as the engine calls it.
 *
 * Only an Effect output schema has an encoder: a foreign Standard Schema library
 * hands over a validator and a JSON Schema and nothing that runs in this
 * direction, so those answers pass through untouched. That is the same call
 * `output-fields.ts` makes for the field list -- what a schema cannot say about
 * itself is not said.
 */
function buildAction<TPayload extends Record<string, unknown>>(
  actionId: string,
  schema: StandardSchema<TPayload>,
  outputSchema: OutputSchema<Record<string, unknown>> | undefined,
  handler: ActionHandler<TPayload, unknown>
): StepFactory {
  const encodeOutput =
    outputSchema !== undefined &&
    isEffectSchema<Record<string, unknown>, never>(outputSchema)
      ? encodeThroughOutputSchema(`Action "${actionId}"`, outputSchema)
      : undefined;

  return () => async (rawInput) => {
    const context = readStepContext(rawInput._context);

    // Every node the engine runs carries its context, so an input without one is
    // a Rova bug rather than something a host wrote. It fails the node here
    // because the alternative is handing an author the node ids they were
    // promised as empty strings, and a run log naming a node that does not exist.
    if (!context) {
      return failed(
        `Action "${actionId}" was called without a step context, so the node it belongs to cannot be identified.`
      );
    }

    // The same three keys a run log leaves out: the handler is told about the
    // connection and the action through its context instead.
    const payload = stripInternalFields(rawInput);
    const validated = validateConfig(schema, payload);
    if (Result.isFailure(validated)) {
      return failed(
        `Action "${actionId}" received an invalid payload: ${validated.failure}`
      );
    }

    try {
      const data = await handler({
        payload: validated.success,
        context: {
          runMode: context.runMode ?? "live",
          executionId: context.executionId,
          nodeId: context.nodeId,
          nodeName: context.nodeName,
          nodeType: context.nodeType,
          integrationId: readIntegrationId(rawInput.integrationId),
        },
      });

      if (!encodeOutput) {
        return { success: true, data };
      }

      // A handler that answered with something its output schema cannot encode
      // will answer with it again on every attempt, so this fails the node once
      // rather than spending the retry budget on a certainty.
      const encoded = encodeOutput(data);
      return Result.isFailure(encoded)
        ? failed(encoded.failure)
        : { success: true, data: encoded.success };
    } catch (error) {
      return failed(getActionErrorMessage(error));
    }
  };
}

function failed(message: string): StepResult {
  return { success: false, error: { message } };
}

/**
 * Define an action of your own, for `createRovaApp({ extensions: { actions } })`.
 *
 * Actions are the executable steps in a workflow. When a workflow reaches an
 * action node, the engine resolves template variables in the config, validates
 * the result against `input`, and calls `handler` with the typed payload. What
 * the handler answers becomes the node's output; throwing fails the node with
 * the thrown message.
 *
 * An `output` written in a foreign Standard Schema library derives the field
 * list but encodes nothing on the way out, since only an Effect schema carries
 * an encoder: a `Date` in a result then survives to JSONB by accident and comes
 * back a string on the replay.
 *
 * @example
 * ```ts
 * const action = defineAction({
 *   id: "appointments/cancel",
 *   label: "Cancel Appointment",
 *   description: "Cancels an appointment and records the reason.",
 *   category: "Appointments",
 *   input: Schema.Struct({
 *     appointmentId: Schema.String.annotate({ description: "Appointment ID" }),
 *     reason: Schema.String.annotate({
 *       description: "Cancellation reason",
 *     }).check(Schema.isMinLength(1)),
 *   }),
 *   output: Schema.Struct({
 *     appointmentId: Schema.String,
 *     status: Schema.String,
 *   }),
 *   handler({ payload }) {
 *     return { appointmentId: payload.appointmentId, status: "cancelled" };
 *   },
 * });
 * ```
 */
export function defineAction<
  TPayload extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
>(input: DefineActionInputWithOutput<TPayload, TOutput>): ActionDefinition;
export function defineAction<TPayload extends Record<string, unknown>>(
  input: DefineActionInput<TPayload>
): ActionDefinition;
export function defineAction<TPayload extends Record<string, unknown>>(
  definition:
    | DefineActionInput<TPayload>
    | DefineActionInputWithOutput<TPayload, Record<string, unknown>>
): ActionDefinition {
  // The one place a schema is bridged. Everything below reads Standard Schema
  // and nothing below knows which library wrote what it is reading.
  const schema = asStandardSchema(definition.input);
  const outputSchema = "output" in definition ? definition.output : undefined;

  // Named rather than spread, so the schemas stay behind. Everything they had
  // to say has been said, into `configFields`, `outputFields` and the step
  // below, and what assembly copies into the catalog is what /api/extensions
  // serializes to the browser -- where a schema object is a dump of one library's
  // internals or nothing at all, depending on who wrote it.
  const normalized = normalizeActionIdentity({
    id: definition.id,
    label: definition.label,
    description: definition.description,
    category: definition.category,
    logoUrl: definition.logoUrl,
  });

  return {
    ...normalized,
    configFields: configFieldsFromInputSchema(schema),
    outputFields: outputSchema
      ? outputFieldsFromSchema(outputSchema)
      : undefined,
    implement: buildAction(
      normalized.id,
      schema,
      outputSchema,
      definition.handler
    ),
    __rovaActionBrand: true,
  };
}
