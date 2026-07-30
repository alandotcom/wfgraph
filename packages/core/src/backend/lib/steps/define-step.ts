/**
 * How an integration writes a step.
 *
 * Everything a step used to do around its own work is here instead: decoding
 * the config the engine resolved, fetching the integration's credentials,
 * writing the run log rows, and turning what the handler answered into the
 * `StepResult` envelope the engine reads. What is left for an author is the
 * schema of what comes in, the schema of what goes out, the metadata the editor
 * draws the action with, and an `Effect` that gets from one schema to the other.
 *
 * The two schemas are load-bearing rather than documentation. The input one is
 * what the handler's parameter type comes from, so a field the schema does not
 * name cannot be read, and each `configFields` key is checked against it. The
 * output one is what the handler's return type comes from and what the editor's
 * template autocomplete lists, so a step whose payload drifts from what
 * downstream nodes are offered stops compiling.
 *
 * **Both directions run through the schema's canonical JSON codec.** A step
 * boundary is JSON on both sides -- the config arrived from a jsonb column
 * through template resolution, and the result is memoized by Inngest -- so what
 * runs is `Schema.toCodecJson(schema)` rather than the schema itself. That is
 * what lets an author write a transform: a comma-separated field becomes a list
 * on the way in, and a `Date` becomes an ISO string on the way out. Encoding
 * through the plain schema would leave a live `Date` in the value, which
 * survives JSONB by accident through `Date.prototype.toJSON` and comes back a
 * string on replay, handing the same memoized step two different types.
 *
 * Two consequences an author meets. On the way in, an optional field takes an
 * absent key or a null and refuses a key present and holding `undefined`, because
 * the codec rewrites `optional(X)` to `optionalKey(NullOr(X))`; the engine writes
 * none of the third kind. On the way out, the encode is a trim as well as a
 * conversion, so a key the output schema does not declare does not survive it.
 *
 * **Stage 7's seam.** The three lines below that reach outside the effect --
 * `withStepLogging`, `fetchCredentials`, and `Effect.runPromise` -- are here
 * because the run engine still calls a step as a Promise and the step logger
 * and credential fetcher still reach the database through module state rather
 * than through a service. Stage 7 of ADR-0002 brings the engine interior
 * across, at which point a step's effect runs inside the app's runtime and
 * these three go away. Nothing above this file's boundary changes when they do:
 * an author writes the same handler either way, which is the reason the seam is
 * here and not in the plugins.
 */

import { Effect, Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import {
  fetchCredentials,
  type WorkflowCredentials,
} from "#src/backend/lib/credential-fetcher";
import {
  readStepContext,
  type StepContext,
  withStepLogging,
} from "#src/backend/lib/steps/step-handler";
import { VendorTransport } from "#src/backend/lib/steps/vendor-transport";
import type {
  ActionConfigField,
  ActionConfigFieldBase,
  ActionConfigFieldGroup,
} from "@rova/shared/plugins/registry";
import { formatSchemaFailure } from "@rova/shared/types/schema-message";
import type {
  StepFunction,
  StepResult,
} from "@rova/shared/workflow/step-result";

/**
 * Why a step could not do its work, in the words the run log shows.
 *
 * One tagged error rather than a family, because the envelope a step answers
 * with carries a message and nothing else: a second tag would render to the
 * same wire bytes and buy only a `catchTag` nobody has needed. A vendor failure
 * becomes one of these in the plugin that knows how to read its vendor's error
 * body, which is the only place that reading can happen accurately.
 */
export class StepFailure extends Schema.TaggedErrorClass<StepFailure>()(
  "StepFailure",
  {
    message: Schema.String,
  }
) {}

/**
 * What the handler is told about the run it is part of.
 *
 * `TCredentials` is the integration's own credential vocabulary, which a handler
 * names by annotating this parameter with `CredentialsOf<typeof fields>`. The
 * default is the open record, for a step belonging to no integration.
 */
export type StepRunContext<TCredentials = WorkflowCredentials> = {
  /** `"test"` when the editor is running the workflow, `"live"` otherwise. */
  readonly runMode: "live" | "test";
  readonly executionId?: string;
  readonly nodeId?: string;
  readonly nodeName?: string;
  readonly nodeType?: string;
  /** The integration the node was configured with, if any. */
  readonly integrationId?: string;
  /**
   * The integration's credentials, fetched the first time the handler asks and
   * not at all if it never does.
   *
   * A step that decides it has nothing to send -- a test run in log-only mode,
   * say -- should not read an integration's secrets to reach that conclusion,
   * so the fetch is an effect the handler yields rather than a value handed to
   * it. Yielding it more than once fetches once.
   */
  readonly credentials: Effect.Effect<TCredentials>;
};

/**
 * A handler, as `defineStep` takes it.
 *
 * The context is typed with the open credential record rather than with a type
 * parameter, and an author who wants their integration's own vocabulary annotates
 * the parameter with `StepRunContext<CredentialsOf<typeof fields>>`. Inferring
 * that vocabulary here instead would cost the inline handler its parameter types:
 * a type parameter appearing only inside a context-sensitive argument cannot be
 * inferred before that argument is typed, so TypeScript falls back to `any` for
 * both parameters and the whole handler goes unchecked.
 */
export type StepHandler<TInput, TOutput> = (
  input: TInput,
  context: StepRunContext
) => Effect.Effect<TOutput, StepFailure, HttpClient.HttpClient>;

/** A config field naming a key the step's input schema declares. */
type ConfigFieldFor<TInput> = Omit<ActionConfigFieldBase, "key"> & {
  key: Extract<keyof TInput, string>;
};

type ConfigFieldGroupFor<TInput> = Omit<ActionConfigFieldGroup, "fields"> & {
  fields: ConfigFieldFor<TInput>[];
};

/**
 * One entry of an action's config form, held to the keys its step can read.
 *
 * A field naming a key the input schema does not declare would render an input
 * whose value the handler never sees, so it fails to compile here rather than
 * being discovered by a builder filling it in.
 */
export type ActionConfigFieldFor<TInput> =
  | ConfigFieldFor<TInput>
  | ConfigFieldGroupFor<TInput>;

/**
 * A step's schemas and metadata, before an integration names it.
 *
 * The id is `${integration.type}/${slug}` and exists only where the integration
 * declares the action, so a step carries everything except its own name and
 * `implement` is where the two meet.
 */
export type ActionStep = {
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly configFields: readonly ActionConfigField[];
  /** The config shape. Assembly holds every required key of it to a field. */
  readonly input: Schema.ConstraintDecoder<unknown>;
  /** What the handler answers, which the editor's field list comes from. */
  readonly output: Schema.ConstraintCodec<unknown, unknown>;
  /** The engine's entry point, once the integration has named the action. */
  readonly implement: (actionId: string) => StepFunction;
};

/**
 * A step registered under an id it names itself, which is how the plugins B4
 * has not ported yet reach `registerStep`.
 *
 * It goes with them: an action's id belongs to the integration that declares it,
 * not to the step, and `ActionStep` above is the shape that says so.
 */
export type StepDefinition<Id extends string = string> = {
  readonly id: Id;
  readonly run: StepFunction;
};

type StepSchemas<TInput, TOutput> = {
  /** The config the engine resolved, as this step reads it. */
  readonly input: Schema.ConstraintDecoder<TInput>;
  /**
   * The payload the handler answers with, and the fields downstream nodes are
   * offered.
   *
   * It is encoded through its canonical JSON codec before the envelope, so a
   * `Date` or an `Option` in it crosses the boundary as JSON. **The encode is
   * also what the payload is trimmed to: a key this schema does not declare does
   * not survive it.** A step handing back a vendor object whole therefore
   * describes every field it means to pass on, or says so in its shape with
   * `Schema.StructWithRest` over a `Schema.Record` rest.
   */
  readonly output: Schema.ConstraintCodec<TOutput, unknown>;
  readonly handler: StepHandler<TInput, TOutput>;
};

type ActionStepInput<TInput, TOutput> = StepSchemas<TInput, TOutput> & {
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly configFields: readonly ActionConfigFieldFor<TInput>[];
};

/**
 * Everything a step does around its handler, as a function of the action id.
 *
 * The id is what both messages below name, and a step learns it from whoever
 * names the action: the integration that declares it, or the `registerStep` call
 * that registers it.
 *
 * `codec` is off for a step still registering itself, and it has to be: those
 * schemas were written against a boundary that neither decoded through a codec nor
 * encoded at all, and several of those handlers pass a vendor object through whole
 * while describing only the fields the editor offers. The encode would trim it.
 * Porting one is where its output schema gets read against what its handler
 * returns.
 *
 * Both readers are built once here rather than per invocation, because
 * `toCodecJson` walks the AST and builds a new schema.
 */
function buildStep<TInput, TOutput>(
  definition: StepSchemas<TInput, TOutput>,
  options: { readonly codec: boolean }
): (actionId: string) => StepFunction {
  // `errors: "all"` is what `formatSchemaFailure` is written against: it counts
  // the issues it does not spell out, and stopping at the first would make that
  // count always zero.
  const decodeInput = Schema.decodeUnknownEffect(
    options.codec ? Schema.toCodecJson(definition.input) : definition.input,
    { errors: "all" }
  );
  const encodeOutput = options.codec
    ? Schema.encodeUnknownEffect(Schema.toCodecJson(definition.output), {
        errors: "all",
      })
    : undefined;

  function runStep(
    actionId: string,
    rawInput: Record<string, unknown>,
    context: StepContext | undefined
  ): Effect.Effect<StepResult> {
    return Effect.gen(function* () {
      const integrationId = readIntegrationId(rawInput.integrationId);
      const credentials = yield* Effect.cached(readCredentials(integrationId));

      const input = yield* decodeInput(rawInput).pipe(
        Effect.mapError(
          (error) =>
            new StepFailure({
              message: `Invalid configuration for "${actionId}": ${formatSchemaFailure(error.issue)}`,
            })
        )
      );

      const data = yield* definition.handler(input, {
        runMode: context?.runMode ?? "live",
        executionId: context?.executionId,
        nodeId: context?.nodeId,
        nodeName: context?.nodeName,
        nodeType: context?.nodeType,
        integrationId,
        credentials,
      });

      if (!encodeOutput) {
        return data;
      }

      // A handler that answered with something its output schema cannot encode
      // will answer with it again on every attempt, so this fails the node once
      // rather than spending the retry budget on a certainty. The path is narrow:
      // the handler's return type is the decoded type, so reaching here takes an
      // `as`, an `any`, or a widened vendor type.
      return yield* encodeOutput(data).pipe(
        Effect.mapError(
          (error) =>
            new StepFailure({
              message: `Step "${actionId}" returned a value its output schema cannot encode: ${formatSchemaFailure(error.issue)}`,
            })
        )
      );
    }).pipe(
      Effect.match({
        onSuccess: (data): StepResult => ({ success: true, data }),
        onFailure: (failure): StepResult => ({
          success: false,
          error: { message: failure.message },
        }),
      }),
      Effect.provide(VendorTransport)
    );
  }

  return (actionId) => (rawInput) => {
    const context = readStepContext(rawInput._context);

    // The logger is handed the input as it arrived, not the decoded view of it:
    // a run log shows what the node was configured with, including the fields
    // this step does not read.
    return withStepLogging({ ...rawInput, _context: context }, () =>
      Effect.runPromise(runStep(actionId, rawInput, context))
    );
  };
}

/**
 * Build a step from its schemas, its metadata, and its handler.
 *
 * @example
 * ```ts
 * export const myIntegration = defineIntegration({
 *   type: "my-service",
 *   label: "My Service",
 *   description: "Does a thing",
 *   credentials: myServiceCredentialFields,
 *   actions: {
 *     "send-thing": defineStep({
 *       label: "Send Thing",
 *       description: "Sends a thing",
 *       category: "My Service",
 *       input: Schema.Struct({ to: Schema.String }),
 *       output: Schema.Struct({ id: Schema.String }),
 *       configFields: [{ key: "to", label: "To", type: "template-input" }],
 *       handler: Effect.fn(function* (input, context) {
 *         const credentials = yield* context.credentials;
 *         return yield* sendThing(credentials.MY_SERVICE_API_KEY, input.to);
 *       }),
 *     }),
 *   },
 * });
 * ```
 */
export function defineStep<TInput, TOutput>(
  definition: ActionStepInput<TInput, TOutput>
): ActionStep {
  return {
    label: definition.label,
    description: definition.description,
    category: definition.category,
    configFields: definition.configFields,
    input: definition.input,
    output: definition.output,
    implement: buildStep(definition, { codec: true }),
  };
}

/**
 * A step that names its own action id, for a plugin whose metadata still lives in
 * the old registry.
 *
 * The five plugins B4 has not ported declare their actions in a registry entry
 * and their steps in separate modules, so a step there has an id and no metadata
 * to carry. This and `registerStep` go together when the last of them moves; the
 * one signature above is what a step looks like after.
 *
 * A separate function rather than a second arm of `defineStep`, for two reasons.
 * The two answer different types, so a caller of either would have to narrow what
 * came back. And a transitional shape with a name of its own is one grep away
 * from every call site that has to go, which an overload is not.
 */
export function defineLegacyStep<Id extends string, TInput, TOutput>(
  definition: StepSchemas<TInput, TOutput> & {
    /** The action id this step implements, as `"integration/slug"`. */
    readonly id: Id;
  }
): StepDefinition<Id> {
  return {
    id: definition.id,
    run: buildStep(definition, { codec: false })(definition.id),
  };
}

function readIntegrationId(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * A step with no integration configured gets no credentials rather than an
 * error, which is what lets an action work against a public API or a default
 * from the environment.
 *
 * `Effect.promise`, not `tryPromise`: a credential store that rejects is a
 * defect, and a defect leaves this step by the throw path, where Inngest's
 * function-level retry picks it up and runs the step again minutes later. That
 * is the right answer for a database that was briefly unreachable.
 * `tryPromise` would turn the same rejection into a typed failure this file
 * would have to render as a step error, ending the run on a condition that
 * would have cleared on its own.
 */
function readCredentials(
  integrationId: string | undefined
): Effect.Effect<WorkflowCredentials> {
  return integrationId === undefined
    ? Effect.succeed({})
    : Effect.promise(() => fetchCredentials(integrationId));
}
