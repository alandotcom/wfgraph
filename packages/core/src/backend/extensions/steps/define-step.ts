/**
 * An Effect schema crosses `Schema.toCodecJson` in both directions, so a
 * transform an author writes (a comma-separated field to a list, a `Date` to an
 * ISO string) runs on the way in and out rather than on the bare schema. A
 * schema from another library validates on the way in and passes through on the
 * way out, because that is the whole of what Standard Schema publishes.
 * `docs/integrations.md` ("Schemas at a step boundary") owns the full contract.
 */

import { Effect, Result, Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import {
  CredentialsUnavailable,
  type WorkflowCredentials,
} from "#src/backend/extensions/credential-fetcher";
import { encodeThroughOutputSchema } from "#src/backend/extensions/steps/output-encoding";
import {
  readIntegrationId,
  readStepContext,
  type StepContext,
} from "#src/backend/extensions/steps/step-handler";
import {
  failedStep,
  type HandlerBag,
  handlerErrorMessage,
  invalidConfigMessage,
  missingContextMessage,
  toHandlerBag,
} from "#src/backend/extensions/steps/step-boundary";
import type {
  StepEnvironment,
  StepFactory,
} from "#src/backend/extensions/steps/step-runner";
import { ExternalTransport } from "#src/backend/extensions/steps/external-transport";
import { buildConfigForm } from "#src/backend/extensions/steps/config-form";
import {
  buildConfigReader,
  configFieldsFromInputSchema,
  type InputSchema,
  isPromiseLike,
} from "#src/backend/extensions/schema-io";
import { asStandardSchema, isEffectSchema } from "@wfgraph/shared/types/schema";
import type { OutputSchema } from "@wfgraph/shared/graph/output-fields";
import type {
  ActionConfigField,
  ActionConfigFieldBase,
  ActionConfigFieldGroup,
} from "@wfgraph/shared/plugins/action-fields";
import type {
  NodeSteps,
  StepResult,
} from "@wfgraph/shared/actions/step-result";
import type { JsonSafe } from "@wfgraph/shared/types/json";

/**
 * Why a step could not do its work, in the words the run log shows.
 *
 * One tagged error rather than a family, because the envelope a step answers
 * with carries a message and nothing else: a second tag would render to the
 * same wire bytes and buy only a `catchTag` nobody has needed. An external failure
 * becomes one of these in the plugin that knows how to read its system's error
 * body, which is the only place that reading can happen accurately.
 */
export class StepFailure extends Schema.TaggedErrorClass<StepFailure>()(
  "StepFailure",
  {
    message: Schema.String,
  }
) {}

/**
 * How a handler remembers work across a replay.
 *
 * A durable runtime re-runs the whole workflow function every time a run
 * resumes, so anything with a side effect goes inside `run` or it happens again
 * on every attempt. Workflow Graph wraps no handler body for you: that is Inngest's model,
 * and an author who reaches a system twice is an author who did not say so here.
 *
 * The Effect overload is the internal shape: integrations yield it and memoize
 * through a `RememberedStep` envelope so a `StepFailure` fails once. The Promise
 * overload is a thin adapter for a host's `defineAction`: it memoizes the bare
 * value, and a throw leaves no stored entry so a function-level retry re-runs.
 *
 * What `run` answers round-trips through JSON on its way into the runtime's
 * storage, and `JsonSafe` is the compiler holding both forms to that. A `Date`,
 * `Map` or `Set` in the answer is refused where it is written, with the offending
 * field named.
 */
export type NodeStepApi = {
  run: StepRunner;
};

type StepRunner = {
  <A>(
    stepId: string,
    work: Effect.Effect<A & JsonSafe<A>, StepFailure, HttpClient.HttpClient>
  ): Effect.Effect<A, StepFailure, HttpClient.HttpClient>;
  <A>(stepId: string, work: () => Promise<A & JsonSafe<A>>): Promise<A>;
};

/** What a memoized step stores, which has to be JSON. */
type RememberedStep<A> =
  | { ok: true; value: A }
  | { ok: false; message: string };

/**
 * Inngest's `run`, without a second `JsonSafe` check on a value that already
 * passed at the author's `step.run` call. Comparing two generic signatures
 * applies the check again to something that is no longer the author's type.
 */
type DurableRemember = <T>(
  stepId: string,
  work: () => Promise<T>
) => Promise<T>;

/**
 * The author's `step`, over the node's durable runtime.
 *
 * Effect is the primary execution shape: work runs to a `RememberedStep`
 * envelope so a `StepFailure` is stored once and re-raised on replay rather
 * than retried. The Promise overload is a thin adapter for host `defineAction`:
 * it memoizes the bare value, and a throw escapes without a stored entry so a
 * function-level retry re-runs the step (Inngest's model for transient errors).
 */
export function nodeStepApi(steps: NodeSteps | undefined): NodeStepApi {
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- JsonSafe was enforced on the author's value at `run`
  const memoize = steps?.run as DurableRemember | undefined;

  // A caller with no durable runtime runs the work where it stands, which is
  // what an in-process test wants and what the engine hands a disabled node.
  const remember: DurableRemember = (stepId, work) =>
    memoize ? memoize(stepId, work) : work();

  /**
   * Effect memoization. Work is run to a `Result` inside the step, so the
   * value the runtime stores is a success either way and a `StepFailure` is
   * re-raised on the far side rather than read as a step to run again.
   */
  const runEffect = <A>(
    stepId: string,
    work: Effect.Effect<A, StepFailure, HttpClient.HttpClient>
  ): Effect.Effect<A, StepFailure> =>
    Effect.gen(function* () {
      const effectContext = yield* Effect.context();
      const answered = yield* Effect.promise(() =>
        // The durability API is Promise-shaped. Running the work on the
        // invocation's current context keeps this the only adapter inside the
        // action rather than starting another managed-runtime fiber.
        remember(stepId, () =>
          Effect.runPromiseWith(effectContext)(
            // A plain shape rather than the `Result` itself: what the runtime
            // stores round-trips through JSON, and an Effect data type does not
            // survive that.
            Effect.map(
              Effect.result(Effect.provide(work, ExternalTransport)),
              (result): RememberedStep<A> =>
                Result.isFailure(result)
                  ? { ok: false, message: result.failure.message }
                  : { ok: true, value: result.success }
            )
          )
        )
      );

      if (answered.ok) {
        return answered.value;
      }

      // Rebuilt rather than passed on: the value crossed JSON, so what arrives
      // on a replay is the message and not the class.
      return yield* new StepFailure({ message: answered.message });
    });

  function run<A>(
    stepId: string,
    work: Effect.Effect<A, StepFailure, HttpClient.HttpClient>
  ): Effect.Effect<A, StepFailure, HttpClient.HttpClient>;
  function run<A>(stepId: string, work: () => Promise<A>): Promise<A>;
  function run<A>(
    stepId: string,
    work:
      | Effect.Effect<A, StepFailure, HttpClient.HttpClient>
      | (() => Promise<A>)
  ): Effect.Effect<A, StepFailure, HttpClient.HttpClient> | Promise<A> {
    if (typeof work === "function") {
      // Bare-value memoization: a throw must not leave a stored entry, or a
      // function-level retry would replay the failure instead of re-running.
      return remember(stepId, work);
    }

    return runEffect(stepId, work);
  }

  return { run };
}

/**
 * An Effect as a Promise that rejects with the failure itself.
 *
 * `Effect.runPromise` would reject with a fiber failure wrapping the cause, and
 * a handler catching that could not tell a refused credential store from
 * anything else. Matching first and rejecting by hand is what keeps
 * `CredentialsUnavailable` recognisable to `stepFailureFrom`, which is what
 * keeps it out of the `StepResult` envelope.
 */
function runToPromise<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(
    Effect.match(effect, {
      onSuccess: (value) => ({ ok: true as const, value }),
      onFailure: (error) => ({ ok: false as const, error }),
    })
  ).then((answered) =>
    answered.ok ? answered.value : Promise.reject(answered.error)
  );
}

/**
 * The one argument a step's handler is called with.
 *
 * `TCredentials` is the integration's own credential vocabulary, which
 * `defineIntegration` infers for a handler written inline. A helper that takes
 * the bag rather than a handler names it, as `acuity/client.ts` does. The default
 * is the open record, for a step belonging to no integration.
 */
export type StepBag<
  TInput,
  TCredentials = WorkflowCredentials,
> = HandlerBag<TInput> & {
  /**
   * The integration's credentials, fetched the first time the handler asks and
   * not at all if it never does.
   *
   * A step that decides it has nothing to send -- a test run in log-only mode,
   * say -- should not read an integration's secrets to reach that conclusion,
   * so the fetch is an effect the handler yields rather than a value handed to
   * it. Yielding it more than once fetches once.
   *
   * A store that refuses the read fails with `CredentialsUnavailable`. Let it
   * through: the node then fails on the store's own message, and catching it
   * would report an outage as something this step decided.
   */
  readonly credentials: Effect.Effect<TCredentials, CredentialsUnavailable>;
  /**
   * The same read for a host `defineAction` written as a plain async function.
   *
   * Integrations yield `credentials` instead. One fetch behind both: awaiting
   * this after yielding `credentials` reaches the value already read. It rejects
   * with the `CredentialsUnavailable` itself, which `defineStep` recognises and
   * fails the node with, so a handler that does not catch it gets that behaviour
   * for free.
   */
  readonly readCredentials: () => Promise<TCredentials>;
  /**
   * Where work with a side effect goes, so a replay reuses it rather than doing
   * it again. Nothing outside it is remembered. Integrations pass an Effect;
   * a host `defineAction` may pass a Promise factory.
   */
  readonly step: NodeStepApi;
};

/**
 * A handler, as `defineStep` takes it.
 *
 * The bag carries the open credential record here, because this is the erased
 * shape every action is built through. `defineIntegration` is where an action's
 * own vocabulary is inferred, and it types each handler before erasing to this.
 */
export type StepHandler<TInput, TOutput> = (
  bag: StepBag<TInput>
) => HandlerAnswer<TOutput>;

/**
 * The three shapes a handler may answer in.
 *
 * Integrations author with an `Effect` (`Effect.fn`): it fails with a
 * `StepFailure` and may ask for the HTTP transport `callExternal` needs. A host
 * `defineAction` may answer a value or a Promise and fail by throwing; the
 * message becomes the run log's sentence. `toHandlerEffect` is the one bridge.
 * Nothing else differs: the config decode, the credential fetch and the output
 * encode are the same either way.
 */
export type HandlerAnswer<TOutput> =
  | TOutput
  | Promise<TOutput>
  | Effect.Effect<
      TOutput,
      StepFailure | CredentialsUnavailable,
      HttpClient.HttpClient
    >;

/**
 * A config field naming a key the step's input schema declares.
 *
 * Every property but the key is optional, because the schema supplies the rest.
 * An author writing `{ key: "body", type: "template-textarea", rows: 4 }` keeps
 * the label and the required flag the schema already stated.
 */
type ConfigFieldFor<TInput> = Partial<Omit<ActionConfigFieldBase, "key">> & {
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
export type ActionStep<TOutput = unknown> = {
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly configFields: readonly ActionConfigField[];
  /** The config shape, which the form is derived from. */
  readonly input: InputSchema<unknown>;
  /**
   * What the handler answers, which the editor's field list comes from.
   *
   * `TOutput` is carried so a test driving an action by slug knows what that
   * action answers with. Assembly reads the erased `ActionStep` and never asks.
   */
  readonly output: OutputSchema<TOutput>;
  /** The engine's entry point, once the integration has named the action. */
  readonly implement: (actionId: string) => StepFactory;
};

type StepSchemas<TInput, TOutput> = {
  /**
   * The config the engine resolved, as this step reads it. Effect Schema, Zod,
   * arktype, or anything else publishing Standard Schema.
   */
  readonly input: InputSchema<TInput>;
  /**
   * The payload the handler answers with, and the fields downstream nodes are
   * offered.
   *
   * An Effect schema is encoded through its canonical JSON codec before the
   * envelope, so a `Date` or an `Option` in it crosses the boundary as JSON.
   * **That encode is also what the payload is trimmed to: a key the schema does
   * not declare does not survive it.** A step handing back a system's object
   * whole therefore describes every field it means to pass on, or says so in its
   * shape with `Schema.StructWithRest` over a `Schema.Record` rest.
   *
   * A schema from another library publishes no encoder, so what the handler
   * answered is passed on as it stands and the trim does not apply. Answer with
   * JSON there: the engine memoizes a step result and replays it.
   */
  readonly output: OutputSchema<TOutput>;
};

export type ActionStepInput<TInput, TOutput> = StepSchemas<TInput, TOutput> & {
  readonly label: string;
  readonly description: string;
  readonly category: string;
  /**
   * What the input schema cannot say about the form: a placeholder, a row
   * count, a friendly option label, a group, a `showWhen`.
   *
   * Every key comes from the schema whether it appears here or not, so a step
   * whose fields need nothing beyond their labels writes none of these.
   */
  readonly configFields?: readonly ActionConfigFieldFor<TInput>[];
  /**
   * Where the work is.
   *
   * `NoInfer` is what keeps the schemas the source of truth: without it the
   * handler's own return type is an inference site too, so a step handing back
   * a system's object would make the output schema answer to that type
   * instead of the other way round.
   */
  readonly handler: StepHandler<NoInfer<TInput>, NoInfer<TOutput>>;
};

/**
 * What a handler threw, as the failure the rest of the step runs on.
 *
 * A credential read that was refused stays what it is, so the node fails on the
 * store's own message rather than on a config the builder could fix. A handler
 * awaiting `readCredentials` and not catching gets that for free; one that
 * catches has decided otherwise.
 */
function stepFailureFrom(
  subject: string
): (error: unknown) => StepFailure | CredentialsUnavailable {
  return (error) =>
    error instanceof CredentialsUnavailable
      ? error
      : new StepFailure({ message: handlerErrorMessage(subject, error) });
}

/** Whatever the handler answered, as the effect the rest of the step runs on. */
function toHandlerEffect<TOutput>(
  answer: HandlerAnswer<TOutput>,
  toFailure: (error: unknown) => StepFailure | CredentialsUnavailable
): Effect.Effect<
  TOutput,
  StepFailure | CredentialsUnavailable,
  HttpClient.HttpClient
> {
  if (Effect.isEffect(answer)) {
    return answer;
  }

  return isPromiseLike<TOutput>(answer)
    ? Effect.tryPromise({ try: () => answer, catch: toFailure })
    : Effect.succeed(answer);
}

/**
 * Everything either authoring function does around its handler, written once.
 *
 * `subject` is the phrase every message below names the offender by: `Step
 * "twilio/send-sms"` where an integration declares the action, `Action
 * "appointments/cancel"` where a host writes one. `output` is optional here for
 * `defineAction`, whose actions may be addressable by node alone; a definition
 * that omits it passes the handler's answer on unencoded.
 */
export function buildStep<TInput, TOutput>(
  definition: Pick<ActionStepInput<TInput, TOutput>, "handler" | "input"> & {
    readonly output?: OutputSchema<TOutput>;
  },
  subject: string
): StepFactory {
  const readConfig = buildConfigReader(definition.input);
  const toFailure = stepFailureFrom(subject);

  // Only an Effect output schema has an encoder. A foreign Standard Schema
  // library publishes a validator and a JSON Schema and nothing that runs in
  // this direction, so its answers pass through as they stand. That is the
  // same call `output-fields.ts` makes for the field list: what a schema
  // cannot say about itself is not said.
  const encodeOutput =
    definition.output && isEffectSchema<TOutput, never>(definition.output)
      ? encodeThroughOutputSchema(subject, definition.output)
      : Result.succeed;

  function runStep(
    app: StepEnvironment,
    rawInput: Record<string, unknown>,
    context: StepContext | undefined,
    steps: NodeSteps | undefined
  ): Effect.Effect<StepResult, CredentialsUnavailable> {
    return Effect.gen(function* () {
      if (!context) {
        return yield* new StepFailure({
          message: missingContextMessage(subject),
        });
      }

      const integrationId = readIntegrationId(rawInput.integrationId);
      const credentials = yield* Effect.cached(
        readCredentials(app, integrationId)
      );

      const parsed = readConfig(rawInput);
      if (Result.isFailure(parsed)) {
        return yield* new StepFailure({
          message: invalidConfigMessage(subject, parsed.failure),
        });
      }
      const input = parsed.success;

      // The call is wrapped too, because a plain function may throw before it
      // answers anything. An `Effect.fn` handler cannot, so this changes nothing
      // for one.
      const answer = yield* Effect.try({
        try: () =>
          definition.handler({
            ...toHandlerBag(input, context, integrationId),
            credentials,
            readCredentials: () => runToPromise(credentials),
            step: nodeStepApi(steps),
          }),
        catch: toFailure,
      });

      const data = yield* toHandlerEffect(answer, toFailure);

      // A handler that answered with something its output schema cannot encode
      // will answer with it again on every attempt, so this fails the node once
      // rather than spending the retry budget on a certainty. The path is narrow:
      // the handler's return type is the decoded type, so reaching here takes an
      // `as`, an `any`, or a widened external type.
      const encoded = encodeOutput(data);
      if (Result.isFailure(encoded)) {
        return yield* new StepFailure({ message: encoded.failure });
      }

      return encoded.success;
    }).pipe(
      Effect.map((data): StepResult => ({ success: true, data })),
      // Only the failure this step can answer for becomes the envelope. A
      // `CredentialsUnavailable` stays in the error channel, where the action
      // dispatch port turns it into an engine failure: the message then names
      // the credential store rather than the step.
      Effect.catchTag("StepFailure", (failure): Effect.Effect<StepResult> =>
        Effect.succeed(failedStep(failure.message))
      ),
      Effect.provide(ExternalTransport)
    );
  }

  return (app) => (rawInput, node) =>
    Effect.uninterruptible(
      runStep(app, rawInput, readStepContext(rawInput._context), node)
    );
}

/**
 * Build a step from its schemas, its metadata, and its handler.
 *
 * Internal: an integration declares an action as an object literal and
 * `defineIntegration` maps each one through here. `docs/integrations.md` and the
 * example on `defineIntegration` own the authoring shape.
 */
export function defineStep<TInput, TOutput>(
  definition: ActionStepInput<TInput, TOutput>
): ActionStep<TOutput> {
  return {
    label: definition.label,
    description: definition.description,
    category: definition.category,
    configFields: buildConfigForm(
      configFieldsFromInputSchema(asStandardSchema(definition.input)),
      definition.configFields ?? []
    ),
    input: definition.input,
    output: definition.output,
    implement: (actionId) => buildStep(definition, `Step "${actionId}"`),
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
): Effect.Effect<WorkflowCredentials, CredentialsUnavailable> {
  // `Effect.cached` at the call site is what makes the fetch happen where the
  // handler yields. `suspend` covers the other half: `credentialsFor` is the
  // app's function, and wrapping it keeps an impure one from reaching the store
  // while the step is still being assembled.
  return integrationId === undefined
    ? Effect.succeed({})
    : Effect.suspend(() => app.credentialsFor(integrationId));
}
