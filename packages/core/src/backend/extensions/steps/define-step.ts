/**
 * How an integration writes a step.
 *
 * Everything a step used to do around its own work is here instead: decoding the
 * config the engine resolved, fetching the integration's credentials, and turning
 * what the handler answered into the `StepResult` envelope the engine reads. What
 * is left for an author is the
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
 * **What runs the handler.** `implement` answers a factory rather than a step,
 * because the one thing around the handler that belongs to the app is the
 * credential store a node's integration is read from. The app supplies it where
 * it builds the engine's action port. The run log rows are the engine's, written
 * through its store around this call.
 */

import { Effect, Result, Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { WorkflowCredentials } from "#src/backend/extensions/credential-fetcher";
import { encodeThroughOutputSchema } from "#src/backend/extensions/steps/output-encoding";
import {
  readIntegrationId,
  readStepContext,
  type StepContext,
} from "#src/backend/extensions/steps/step-handler";
import type {
  StepEnvironment,
  StepFactory,
} from "#src/backend/extensions/steps/step-runner";
import { VendorTransport } from "#src/backend/extensions/steps/vendor-transport";
import type {
  ActionConfigField,
  ActionConfigFieldBase,
  ActionConfigFieldGroup,
} from "@rova/shared/plugins/action-fields";
import { formatSchemaFailure } from "@rova/shared/types/schema-message";
import type { StepResult } from "@rova/shared/actions/step-result";

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
  readonly implement: (actionId: string) => StepFactory;
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
};

type ActionStepInput<TInput, TOutput> = StepSchemas<TInput, TOutput> & {
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly configFields: readonly ActionConfigFieldFor<TInput>[];
  /**
   * Where the work is.
   *
   * `NoInfer` is what keeps the schemas the source of truth: without it the
   * handler's own return type is an inference site too, so a step handing back
   * a vendor object would make the output schema answer to the vendor's type
   * instead of the other way round.
   */
  readonly handler: StepHandler<NoInfer<TInput>, NoInfer<TOutput>>;
};

/**
 * Everything a step does around its handler, as a function of the action id.
 *
 * The id is what both messages below name, and a step learns it from the
 * integration that declares the action, at assembly.
 *
 * Both readers are built once per action rather than per invocation, because
 * `toCodecJson` walks the AST and builds a new schema.
 */
function buildStep<TInput, TOutput>(
  definition: Pick<
    ActionStepInput<TInput, TOutput>,
    "handler" | "input" | "output"
  >
): (actionId: string) => StepFactory {
  // `errors: "all"` is what `formatSchemaFailure` is written against: it counts
  // the issues it does not spell out, and stopping at the first would make that
  // count always zero.
  const decodeInput = Schema.decodeUnknownEffect(
    Schema.toCodecJson(definition.input),
    { errors: "all" }
  );

  function runStep(
    app: StepEnvironment,
    actionId: string,
    encodeOutput: (value: unknown) => Result.Result<unknown, string>,
    rawInput: Record<string, unknown>,
    context: StepContext | undefined
  ): Effect.Effect<StepResult> {
    return Effect.gen(function* () {
      const integrationId = readIntegrationId(rawInput.integrationId);
      const credentials = yield* Effect.cached(
        readCredentials(app, integrationId)
      );

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

      // A handler that answered with something its output schema cannot encode
      // will answer with it again on every attempt, so this fails the node once
      // rather than spending the retry budget on a certainty. The path is narrow:
      // the handler's return type is the decoded type, so reaching here takes an
      // `as`, an `any`, or a widened vendor type.
      const encoded = encodeOutput(data);
      if (Result.isFailure(encoded)) {
        return yield* Effect.fail(
          new StepFailure({ message: encoded.failure })
        );
      }

      return encoded.success;
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

  return (actionId) => {
    const encodeOutput = encodeThroughOutputSchema(
      `Step "${actionId}"`,
      definition.output
    );

    return (app) => (rawInput) =>
      Effect.runPromise(
        runStep(
          app,
          actionId,
          encodeOutput,
          rawInput,
          readStepContext(rawInput._context)
        )
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
    implement: buildStep(definition),
  };
}

/**
 * A step with no integration configured gets no credentials rather than an
 * error, which is what lets an action work against a public API or a default
 * from the environment.
 */
function readCredentials(
  app: StepEnvironment,
  integrationId: string | undefined
): Effect.Effect<WorkflowCredentials> {
  // `Effect.cached` at the call site is what makes the fetch happen where the
  // handler yields. `suspend` covers the other half: `credentialsFor` is the
  // app's function, and wrapping it keeps an impure one from reaching the store
  // while the step is still being assembled.
  return integrationId === undefined
    ? Effect.succeed({})
    : Effect.suspend(() => app.credentialsFor(integrationId));
}
