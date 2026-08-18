/**
 * An integration as one value: its credentials, its actions, and the connection
 * test behind them.
 *
 * Nothing registers on import. A host hands the value to `createWfGraphApp` under
 * `extensions.integrations`, so the line that turns an integration on is a line
 * in the host's code rather than a consequence of what happens to be installed.
 *
 * The record key is the action slug, and it is the only place the slug exists:
 * the action id `${type}/${slug}` is computed at assembly, so it is never
 * written twice and never written differently in two places. `defineStep` holds
 * everything else an action needs, which is why nothing here mentions a handler.
 */

import type { IntegrationTestLoader } from "#src/backend/extensions/integration-test";
import {
  type ActionConfigFieldFor,
  type ActionStep,
  type ActionStepInput,
  defineStep,
  type HandlerAnswer,
  type StepBag,
} from "#src/backend/extensions/steps/define-step";
import type { InputSchema } from "#src/backend/extensions/schema-io";
import {
  type CredentialFields,
  formatActionId,
} from "@wfgraph/shared/extensions/catalog";
import type { ReferenceField } from "@wfgraph/shared/graph/node-references";
import {
  type OutputSchema,
  requireOutputFieldsFromSchema,
} from "@wfgraph/shared/graph/output-fields";

/**
 * The credential keys a handler of this integration may read.
 *
 * The keys come off the record the integration declared, so a handler naming one
 * it never declared fails to compile. Every value is optional because an operator
 * may have filled in part of the form: a handler decides what it can do without,
 * and says so in the message it fails with.
 */
export type CredentialsOf<TFields extends CredentialFields> = Partial<
  Record<Extract<keyof TFields, string>, string>
>;

export type IntegrationDefinition = {
  readonly kind: "integration";
  /**
   * Keys the stored credentials, and prefixes every action id.
   *
   * Any string: the set of types a server holds is whatever was passed to
   * `createWfGraphApp`, and the assembled catalog is what a reader asks.
   */
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly credentials: CredentialFields;
  /**
   * What "Test connection" calls, absent when the integration offers none.
   *
   * A loader rather than a function: a connection test reaches the vendor over
   * the network, so it stays behind a dynamic import until someone presses the
   * button.
   */
  readonly test?: IntegrationTestLoader;
  /** Keyed by action slug. */
  readonly actions: Readonly<Record<string, ActionStep>>;
};

/**
 * The half of an action carrying its input: the schema, the form fields held to
 * that schema's keys, and the handler.
 *
 * Split from its output half so that `TOutputs` below gets an inference site of
 * its own. One mapped type holding both leaves `TOutputs` at its constraint,
 * which silently retires the `NoInfer` that keeps the output schema, rather than
 * the handler's return, the source of truth.
 */
type ActionInputSide<TCredentials, TInput, TOutput> = {
  readonly label: string;
  readonly description: string;
  /** Defaults to the integration's own label, which is the usual heading. */
  readonly category?: string;
  /**
   * Whether running this action changes something outside the workflow: a
   * message sent, a record written or removed. Defaults to `false`, which says
   * the action only reads, and that is what lets a Group hold it. See
   * `ActionStepInput` for how this differs from the replay sense of the phrase.
   */
  readonly sideEffect?: boolean;
  readonly input: InputSchema<TInput>;
  readonly configFields?: readonly ActionConfigFieldFor<TInput>[];
  readonly handler: (
    bag: StepBag<NoInfer<TInput>, TCredentials>
  ) => HandlerAnswer<TOutput>;
};

type ActionOutputSide<TOutput> = {
  readonly output: OutputSchema<TOutput>;
};

type IntegrationActions<TCredentials, TInputs, TOutputs> = {
  readonly [K in keyof TInputs]: ActionInputSide<
    TCredentials,
    TInputs[K],
    K extends keyof TOutputs ? NoInfer<TOutputs[K]> : never
  >;
} & {
  readonly [K in keyof TOutputs]: ActionOutputSide<TOutputs[K]>;
};

/**
 * An integration with its action slugs and their output types still in hand.
 *
 * Assembly reads the erased `IntegrationDefinition` and asks for none of this.
 * It is here for a caller naming an action by slug, which is what `runAction`
 * in `@wfgraph/core/testing` does.
 */
export type Integration<
  TInputs extends Record<string, unknown> = Record<string, unknown>,
  TOutputs extends Record<string, unknown> = Record<string, unknown>,
> = Omit<IntegrationDefinition, "actions"> & {
  readonly actions: {
    readonly [K in keyof TInputs]: ActionStep<
      K extends keyof TOutputs ? TOutputs[K] : never
    >;
  };
};

/**
 * Declare an integration: its credentials, its actions, and the connection test
 * behind them.
 *
 * An action is an object literal, so the credential vocabulary and each action's
 * own input type reach its handler without an annotation. A handler naming a
 * credential the record never declared fails to compile, as does a config field
 * naming a key the input schema never declared.
 *
 * @example
 * ```ts
 * export const myService = defineIntegration({
 *   type: "my-service",
 *   label: "My Service",
 *   description: "Does a thing",
 *   credentials: { MY_SERVICE_API_KEY: { label: "API Key", type: "password" } },
 *   actions: {
 *     "send-thing": {
 *       label: "Send Thing",
 *       description: "Sends a thing",
 *       input: Schema.Struct({ to: Schema.String }),
 *       output: Schema.Struct({ id: Schema.String }),
 *       handler: Effect.fn(function* (bag) {
 *         const { MY_SERVICE_API_KEY } = yield* bag.credentials;
 *         return yield* sendThing(MY_SERVICE_API_KEY, bag.input.to);
 *       }),
 *     },
 *   },
 * });
 * ```
 */
export function defineIntegration<
  const TCredentials extends CredentialFields,
  TInputs extends Record<string, unknown>,
  TOutputs extends Record<string, unknown>,
>(input: {
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly credentials: TCredentials;
  readonly test?: IntegrationTestLoader<CredentialsOf<TCredentials>>;
  readonly actions: IntegrationActions<
    CredentialsOf<TCredentials>,
    TInputs,
    TOutputs
  >;
}): Integration<TInputs, TOutputs>;
/**
 * The body runs on the erased shape. The signature above has said everything the
 * types have to say, and an overload is what hands the body the widened record
 * without an assertion at each of the seven members.
 */
export function defineIntegration(input: {
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly credentials: CredentialFields;
  readonly test?: IntegrationTestLoader;
  readonly actions: Readonly<Record<string, unknown>>;
}): IntegrationDefinition {
  const actions: Record<string, ActionStep> = {};

  for (const [slug, action] of Object.entries(input.actions)) {
    if (!isDeclaredAction(action)) {
      throw new Error(
        `Integration "${input.type}" declares the action "${slug}" without an input schema, an output schema, or a handler. All three are what an action is.`
      );
    }

    actions[slug] = defineStep({
      ...action,
      // An action's heading is its integration's label unless it says otherwise,
      // which is what every built-in wanted and none of them had to write.
      category: action.category ?? input.label,
    });
  }

  return {
    kind: "integration",
    type: input.type,
    label: input.label,
    description: input.description,
    credentials: input.credentials,
    test: input.test,
    actions,
  };
}

/** One action with its inference done, as `defineStep` takes it. */
type DeclaredAction = Omit<ActionStepInput<unknown, unknown>, "category"> & {
  readonly category?: string;
};

/**
 * Whether an entry of the actions record is an action at all.
 *
 * The signature above has already held every entry to its shape, so this only
 * answers false for a caller with no types: TypeScript cannot relate the generic
 * record it checked to the erased one the body reads, and a check the run time
 * can make is what bridges them without an assertion.
 */
function isDeclaredAction(value: unknown): value is DeclaredAction {
  return (
    typeof value === "object" &&
    value !== null &&
    "input" in value &&
    "output" in value &&
    "handler" in value
  );
}

/** One action of an integration, named and with its field list derived. */
export type CheckedAction = {
  /** `${integration.type}/${slug}`, which is where the id first exists. */
  readonly id: string;
  readonly step: ActionStep;
  /** What the editor offers downstream nodes, read from the output schema. */
  readonly outputFields: readonly ReferenceField[];
};

/**
 * Hold an integration's actions to what the editor and the engine need of them,
 * naming the offender.
 *
 * Assembly calls this for every integration a host passes, so a bad definition
 * fails the app that turned it on. It is exported for the package that wrote the
 * definition to call in its own suite: a host meeting the throw at startup is the
 * right place for a host and the wrong place for the author, where a missing
 * annotation would otherwise pass review as a green run.
 */
export function checkIntegration(
  integration: IntegrationDefinition
): readonly CheckedAction[] {
  return Object.entries(integration.actions).map(([slug, step]) => {
    const id = formatActionId(integration.type, slug);

    const outputFields = requireOutputFieldsFromSchema(
      `Action "${id}"`,
      step.output
    );

    return { id, step, outputFields };
  });
}
