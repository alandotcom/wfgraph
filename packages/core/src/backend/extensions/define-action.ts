/**
 * How a host writes an action of its own.
 *
 * The step half of the same vocabulary is `defineStep`, and the two read alike
 * on purpose: `input`, `output`, `handler`. Everything between the engine's
 * input record and the handler is `buildStep`, which both call and neither
 * copies. What is here is the identity an action carries, because a host's
 * action names itself where an integration names its steps.
 *
 * This is server code: `buildStep` runs the host's handler and builds the
 * `StepResult` envelope the engine reads, so the file lives beside assembly
 * rather than in the shared package the browser also pulls from.
 */

import {
  buildStep,
  type HandlerAnswer,
  type StepBag,
} from "#src/backend/extensions/steps/define-step";
import type { StepFactory } from "#src/backend/extensions/steps/step-runner";
import type { ActionConfigField } from "@wfgraph/shared/plugins/action-fields";
import {
  configFieldsFromInputSchema,
  type InputSchema,
} from "#src/backend/extensions/schema-io";
import { asStandardSchema } from "@wfgraph/shared/types/schema";
import type { ReferenceField } from "@wfgraph/shared/graph/node-references";
import {
  type OutputSchema,
  outputFieldsFromSchema,
} from "@wfgraph/shared/graph/output-fields";

/**
 * The one argument an action's handler is called with, which is the bag a step's
 * handler reads.
 *
 * The credential reads on it answer whichever connection the node was
 * configured with, and an empty record for a node configured with none, which is
 * the ordinary case for a host action.
 */
export type ActionBag<TInput> = StepBag<TInput>;

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
  category?: string | undefined;

  /** Optional URL to a logo/icon displayed next to the action in the editor. */
  logoUrl?: string | undefined;

  /**
   * Whether running this action changes something outside the workflow: a
   * message sent, a record written or removed. Defaults to `false`, and the
   * editor keeps an action declaring `true` out of a Group. `ActionStepInput`
   * separates this from the replay sense of the phrase.
   */
  sideEffect?: boolean | undefined;

  /**
   * When true, the editor's action picker omits this action; the handler stays
   * registered for runs and existing nodes.
   */
  hidden?: boolean | undefined;
};

/**
 * What `defineAction` hands back: identity, the fields derived from its schemas,
 * and the implementation, everything filled in.
 *
 * `category` and `sideEffect` are no longer optional, because the defaults have
 * been applied by the time a value of this type exists, and assembly copies
 * them into the catalog without deciding anything of its own.
 */
export type ActionDefinition = ActionIdentity & {
  readonly category: string;
  readonly sideEffect: boolean;

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
  readonly outputFields?: ReferenceField[] | undefined;

  /**
   * The engine's entry point, in the shape `stepFor` answers with.
   *
   * A step's is a function of the action id, because an integration names its
   * actions and the step never sees the id until assembly. An action carries its
   * own id, so this is the factory itself.
   */
  readonly implement: StepFactory;
  readonly __wfgraphActionBrand: true;
};

/**
 * The handler, in the three forms an author writes it.
 *
 * It answers its output rather than an envelope: `defineAction` builds the
 * `{ success, data }` wrapper the engine reads, the same way `defineStep` does.
 * A value or a Promise fails the node by throwing, and an `Effect` by failing
 * with a `StepFailure`; either message becomes the run log's sentence.
 */
type ActionHandler<TInput, TOutput> = (
  bag: ActionBag<TInput>
) => HandlerAnswer<TOutput>;

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
): ActionIdentity & { category: string; sideEffect: boolean } {
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
    sideEffect: definition.sideEffect ?? false,
    logoUrl: logoUrl || undefined,
  };
}

/**
 * Define an action of your own, for `createWfGraphApp({ extensions: { actions } })`.
 *
 * Actions are the executable steps in a workflow. When a workflow reaches an
 * action node, the engine resolves template variables in the config, validates
 * the result against `input`, and calls `handler` with the typed config. What
 * the handler answers becomes the node's output. A handler written as a plain
 * or `async` function fails the node by throwing; one written as an `Effect`
 * fails it with a `StepFailure`. Either message becomes the run log's sentence.
 *
 * An `output` written in a foreign Standard Schema library derives the field
 * list and validates the handler's answer through `~standard.validate` on the
 * way out. Only an Effect schema carries an encoder, so a `Date` in a Zod
 * result still survives to JSONB by accident and comes back a string on the
 * replay: answer with JSON there.
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
    sideEffect: definition.sideEffect,
    logoUrl: definition.logoUrl,
    hidden: definition.hidden,
  });

  return {
    ...normalized,
    configFields: configFieldsFromInputSchema(schema),
    outputFields: outputSchema
      ? outputFieldsFromSchema(outputSchema)
      : undefined,
    // `unknown` is the output type this overload has erased to: the branded
    // definition carries no `TOutput`, and the encoder is decided from the
    // schema value rather than from the type.
    implement: buildStep<TInput, unknown>(
      {
        input: definition.input,
        output: outputSchema,
        handler: definition.handler,
      },
      `Action "${normalized.id}"`
    ),
    __wfgraphActionBrand: true,
  };
}
