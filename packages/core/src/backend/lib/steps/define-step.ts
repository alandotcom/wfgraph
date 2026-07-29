/**
 * How an integration writes a step.
 *
 * Everything a step used to do around its own work is here instead: decoding
 * the config the engine resolved, fetching the integration's credentials,
 * writing the run log rows, and turning what the handler answered into the
 * `StepResult` envelope the engine reads. What is left for an author is the
 * schema of what comes in, the schema of what goes out, and an `Effect` that
 * gets from one to the other.
 *
 * The two schemas are load-bearing rather than documentation. The input one is
 * what the handler's parameter type comes from, so a field the schema does not
 * name cannot be read. The output one is what the handler's return type comes
 * from and what the editor's template autocomplete lists, so a step whose
 * payload drifts from what downstream nodes are offered stops compiling.
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

/** What the handler is told about the run it is part of. */
export type StepRunContext = {
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
  readonly credentials: Effect.Effect<WorkflowCredentials>;
};

/**
 * A step, as the registry holds it.
 *
 * The id is part of the type so that registering a step under a key it does not
 * answer to fails to compile. It used to be a pair of strings the compiler
 * could not check: an action id and the name of an export to look for in a
 * module.
 */
export type StepDefinition<Id extends string = string> = {
  readonly id: Id;
  readonly run: StepFunction;
};

export type StepHandler<TInput, TOutput> = (
  input: TInput,
  context: StepRunContext
) => Effect.Effect<TOutput, StepFailure, HttpClient.HttpClient>;

/**
 * Build a step from its schemas and its handler.
 *
 * @example
 * ```ts
 * export const sendThingStep = defineStep({
 *   id: "my-service/send-thing",
 *   input: Schema.Struct({ to: Schema.String }),
 *   output: Schema.Struct({ id: Schema.String }),
 *   handler: Effect.fn(function* (input, context) {
 *     const credentials = yield* context.credentials;
 *     const key = credentials.MY_SERVICE_API_KEY;
 *     if (!key) {
 *       return yield* Effect.fail(
 *         new StepFailure({ message: "MY_SERVICE_API_KEY is not configured." })
 *       );
 *     }
 *     return yield* sendThing(key, input.to);
 *   }),
 * });
 * ```
 */
export function defineStep<Id extends string, TInput, TOutput>(definition: {
  /** The action id this step implements, as `"integration/slug"`. */
  readonly id: Id;
  /** The config the engine resolved, as this step reads it. */
  readonly input: Schema.ConstraintDecoder<TInput>;
  /**
   * The payload the handler answers with, and the fields downstream nodes are
   * offered. It describes JSON: a step result is memoized by Inngest between
   * steps, so a `Date`, a `Map`, or a `Set` would not survive the round trip.
   */
  readonly output: Schema.ConstraintDecoder<TOutput>;
  readonly handler: StepHandler<TInput, TOutput>;
}): StepDefinition<Id> {
  // `errors: "all"` is what `formatSchemaFailure` is written against: it counts
  // the issues it does not spell out, and stopping at the first would make that
  // count always zero.
  const decodeInput = Schema.decodeUnknownEffect(definition.input, {
    errors: "all",
  });

  function runStep(
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
              message: `Invalid configuration for "${definition.id}": ${formatSchemaFailure(error.issue)}`,
            })
        )
      );

      return yield* definition.handler(input, {
        runMode: context?.runMode ?? "live",
        executionId: context?.executionId,
        nodeId: context?.nodeId,
        nodeName: context?.nodeName,
        nodeType: context?.nodeType,
        integrationId,
        credentials,
      });
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

  const run: StepFunction = (rawInput) => {
    const context = readStepContext(rawInput._context);

    // The logger is handed the input as it arrived, not the decoded view of it:
    // a run log shows what the node was configured with, including the fields
    // this step does not read.
    return withStepLogging({ ...rawInput, _context: context }, () =>
      Effect.runPromise(runStep(rawInput, context))
    );
  };

  return { id: definition.id, run };
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
