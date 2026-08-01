/**
 * How a host writes an action of its own.
 *
 * The step half of the same vocabulary is `defineStep`, and the two read alike on
 * purpose: `input`, `output`, `handler`. What sits between the engine's input
 * record and the handler is the same work, and both call it in
 * `steps/step-boundary.ts` rather than each wording it. One thing differs: a
 * step belongs to an integration and reads its credentials, so a step's handler
 * may also answer an `Effect` whose error channel carries a refused credential
 * read out to the durable runtime. An action belongs to no integration.
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
} from "#src/backend/extensions/steps/step-handler";
import {
  failedStep,
  type HandlerBag,
  handlerErrorMessage,
  invalidConfigMessage,
  missingContextMessage,
  toHandlerBag,
} from "#src/backend/extensions/steps/step-boundary";
import {
  nodeStepApi,
  type NodeStepApi,
} from "#src/backend/extensions/steps/define-step";
import { encodeThroughOutputSchema } from "#src/backend/extensions/steps/output-encoding";
import type { StepFactory } from "#src/backend/extensions/steps/step-runner";
import type { ActionConfigField } from "@rova/shared/plugins/action-fields";
import {
  buildConfigReader,
  configFieldsFromInputSchema,
  type InputSchema,
} from "#src/backend/extensions/schema-io";
import { asStandardSchema, isEffectSchema } from "@rova/shared/types/schema";
import type { ReferenceField } from "@rova/shared/graph/node-references";
import {
  type OutputSchema,
  outputFieldsFromSchema,
} from "@rova/shared/graph/output-fields";

/**
 * The one argument an action's handler is called with.
 *
 * The step half calls this `StepBag` and adds the credentials an action has no
 * integration to read. Both are the one bag in `step-boundary.ts`.
 */
export type ActionBag<TInput> = HandlerBag<TInput> & {
  /**
   * Where work with a side effect goes, so a replay reuses it rather than doing
   * it again. Nothing outside it is remembered.
   */
  readonly step: NodeStepApi;
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
   * `"text"`, `"number"`, `"select"`, and `"key-value"`.
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
 * It answers its output rather than an envelope: `defineAction` builds the
 * `{ success, data }` wrapper the engine reads, the same way `defineStep` does.
 * To fail the node, throw -- the message becomes the run log's sentence.
 */
type ActionHandler<TInput, TOutput> = (
  bag: ActionBag<TInput>
) => TOutput | Promise<TOutput>;

export type DefineActionInput<TInput extends Record<string, unknown>> =
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
    input: InputSchema<TInput>;

    /**
     * Where the work is. An action with no `output` is addressable by node and
     * not by field, so what this answers is passed on untyped and unencoded.
     */
    handler: ActionHandler<TInput, unknown>;
  };

export type DefineActionInputWithOutput<
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
> = ActionIdentity & {
  input: InputSchema<TInput>;
  /**
   * The schema describing what the handler answers with. Auto-derives
   * `outputFields` via `~standard.jsonSchema.output()` and types the return.
   */
  output: OutputSchema<TOutput>;
  /**
   * Where the work is.
   *
   * `NoInfer` is what keeps the schemas the source of truth. Without it the
   * handler's own return is an inference site too, so an action answering with
   * fewer fields than `output` declares makes the schema answer to the handler
   * and the editor then offers a field no run produces.
   */
  handler: ActionHandler<NoInfer<TInput>, NoInfer<TOutput>>;
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
 * Everything an action does around its handler, as the engine calls it.
 *
 * Only an Effect output schema has an encoder: a foreign Standard Schema library
 * hands over a validator and a JSON Schema and nothing that runs in this
 * direction, so those answers pass through untouched. That is the same call
 * `output-fields.ts` makes for the field list -- what a schema cannot say about
 * itself is not said.
 */
function buildAction<TInput extends Record<string, unknown>>(
  actionId: string,
  input: InputSchema<TInput>,
  outputSchema: OutputSchema<Record<string, unknown>> | undefined,
  handler: ActionHandler<TInput, unknown>
): StepFactory {
  const subject = `Action "${actionId}"`;
  const readConfig = buildConfigReader(input);
  const encodeOutput =
    outputSchema !== undefined &&
    isEffectSchema<Record<string, unknown>, never>(outputSchema)
      ? encodeThroughOutputSchema(subject, outputSchema)
      : undefined;

  return (app) => async (rawInput, node) => {
    const context = readStepContext(rawInput._context);
    if (!context) {
      return failedStep(missingContextMessage(subject));
    }

    const parsed = readConfig(rawInput);
    if (Result.isFailure(parsed)) {
      return failedStep(invalidConfigMessage(subject, parsed.failure));
    }

    try {
      // The connection reaches the handler beside its config rather than inside
      // it, which is why the read happens here and not in the config.
      const data = await handler({
        ...toHandlerBag(
          parsed.success,
          context,
          readIntegrationId(rawInput.integrationId)
        ),
        step: nodeStepApi(app, node?.steps),
      });

      if (!encodeOutput) {
        return { success: true, data };
      }

      // A handler that answered with something its output schema cannot encode
      // will answer with it again on every attempt, so this fails the node once
      // rather than spending the retry budget on a certainty.
      const encoded = encodeOutput(data);
      return Result.isFailure(encoded)
        ? failedStep(encoded.failure)
        : { success: true, data: encoded.success };
    } catch (error) {
      return failedStep(handlerErrorMessage(subject, error));
    }
  };
}

/**
 * Define an action of your own, for `createRovaApp({ extensions: { actions } })`.
 *
 * Actions are the executable steps in a workflow. When a workflow reaches an
 * action node, the engine resolves template variables in the config, validates
 * the result against `input`, and calls `handler` with the typed config. What
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
 *   handler({ input }) {
 *     return { appointmentId: input.appointmentId, status: "cancelled" };
 *   },
 * });
 * ```
 */
export function defineAction<
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
>(input: DefineActionInputWithOutput<TInput, TOutput>): ActionDefinition;
export function defineAction<TInput extends Record<string, unknown>>(
  input: DefineActionInput<TInput>
): ActionDefinition;
export function defineAction<TInput extends Record<string, unknown>>(
  definition:
    | DefineActionInput<TInput>
    | DefineActionInputWithOutput<TInput, Record<string, unknown>>
): ActionDefinition {
  // The one place a schema is bridged. Effect's bridge assigns onto the schema
  // rather than wrapping it, so `definition.input` below is the same object,
  // now carrying the `~standard` half the field derivation reads.
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
      definition.input,
      outputSchema,
      definition.handler
    ),
    __rovaActionBrand: true,
  };
}
