/**
 * Running one action the way a workflow runs it: an integration's action with
 * `runAction`, which answers an Effect, and a host's `defineAction` with
 * `runHostAction`, which answers a Promise.
 *
 * A separate entry from `@wfgraph/core/plugin` because nothing here runs in a
 * server: a test suite imports it, and a server bundle never reaches it. What
 * it drives is the whole step boundary, so a case sees the config decode, the
 * credential fetch, the handler, the output encode and the envelope, rather
 * than the handler alone.
 */

import { Effect } from "effect";
import type { ActionDefinition } from "#src/backend/extensions/define-action";
import type {
  CredentialsUnavailable,
  WorkflowCredentials,
} from "#src/backend/extensions/credential-fetcher";
import type { Integration } from "#src/backend/extensions/define-integration";
import type { ActionStep } from "#src/backend/extensions/steps/define-step";
import type { StepEnvironment } from "#src/backend/extensions/steps/step-runner";
import { formatActionId } from "@wfgraph/shared/extensions/catalog";
import type {
  NodeSteps,
  StepError,
  StepResult,
} from "@wfgraph/shared/actions/step-result";

/** What the action under test answers with, read off the step it was built into. */
type OutputOf<TAction> =
  TAction extends ActionStep<infer TOutput> ? TOutput : never;

/**
 * The credentials a case supplies.
 *
 * An `Effect` is what a case pinning the lazy read supplies: the step hands the
 * handler the fetch rather than the value, so a handler that decides it has
 * nothing to send never runs it, and an `Effect.sync` counting its calls is what
 * proves that.
 */
type SuppliedCredentials =
  | Readonly<Record<string, string | undefined>>
  | Effect.Effect<WorkflowCredentials, CredentialsUnavailable>;

/** The node a case is standing in for, where it cares which node that is. */
type NodeUnderTest = {
  readonly nodeId?: string | undefined;
  readonly nodeName?: string | undefined;
  readonly nodeType?: string | undefined;
  readonly executionId?: string | undefined;
};

const TEST_INTEGRATION_ID = "int_test";
/**
 * The run a case stands in for when its `node` names none. A handler's
 * idempotency key is derived from it, so the key is always present.
 */
const TEST_EXECUTION_ID = "execution_test";

/**
 * Run one action of an integration and answer the envelope the engine reads.
 *
 * `slug` is held to the keys the integration declared, so a renamed action
 * fails to compile here rather than passing as a case that silently stopped
 * covering anything.
 *
 * `input` is the resolved config as the engine builds it, which is the encoded
 * side: a schema that transforms decodes it on the way in, so a case supplies
 * the text a builder would have typed.
 *
 * CAVEAT on the answer's type. It is described by what the handler returns, and
 * the value is what the output schema encoded, so the two differ for a schema
 * that transforms on the way out: an Effect `Schema.Date` is typed here as a
 * `Date` and arrives as an ISO string. `OutputSchema` carries the decoded side
 * alone, so there is nothing better to read it off yet. Assert on the encoded
 * value, which is also what the engine memoizes and the Runs view shows.
 */
export function runAction<
  TIntegration extends Integration,
  TSlug extends Extract<keyof TIntegration["actions"], string>,
>(
  integration: TIntegration,
  slug: TSlug,
  run: {
    readonly input: Readonly<Record<string, unknown>>;
    readonly credentials?: SuppliedCredentials | undefined;
    readonly runMode?: "live" | "test" | undefined;
    readonly node?: NodeUnderTest | undefined;
  }
): Effect.Effect<
  StepResult<OutputOf<TIntegration["actions"][TSlug]>>,
  CredentialsUnavailable
>;
/**
 * The body runs on the erased step, which answers `StepResult` and nothing
 * narrower. An overload is what rejoins that with the output type `ActionStep`
 * carried this far, rather than an assertion on the way out.
 */
export function runAction(
  integration: Integration,
  slug: string,
  run: {
    readonly input: Readonly<Record<string, unknown>>;
    readonly credentials?: SuppliedCredentials | undefined;
    readonly runMode?: "live" | "test" | undefined;
    readonly node?: NodeUnderTest | undefined;
  }
): Effect.Effect<StepResult, CredentialsUnavailable> {
  const step = integration.actions[slug].implement(
    formatActionId(integration.type, slug)
  );

  const environment: StepEnvironment = {
    credentialsFor: () => toCredentialEffect(run.credentials),
  };

  return step(environment)({
    ...run.input,
    // A step reads its credentials by integration id, so an action given none
    // never fetches, which is what an action against a public API does.
    integrationId:
      run.credentials === undefined ? undefined : TEST_INTEGRATION_ID,
    _context: {
      runMode: run.runMode ?? "live",
      nodeId: run.node?.nodeId ?? "node_1",
      nodeName: run.node?.nodeName ?? integration.label,
      nodeType: run.node?.nodeType ?? "action",
      executionId: run.node?.executionId ?? TEST_EXECUTION_ID,
    },
  });
}

/**
 * One `step.run` a host action made, in call order. `replayed` is true when
 * the case's `replay` answered it, the way the executor answers a step that
 * ran on an earlier pass, and the work did not run.
 */
export type RecordedStep = {
  readonly id: string;
  readonly replayed: boolean;
} & (
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string }
);

/** What `runHostAction` answers. */
export type HostActionRun = {
  /** The envelope the engine reads: the output, or the reason the node failed. */
  readonly result: StepResult;
  /** Every `step.run` the handler made, in order. */
  readonly steps: readonly RecordedStep[];
};

/**
 * Run a host action built with `defineAction` and answer the envelope the
 * engine reads, beside every `step.run` its handler made.
 *
 * `input` is the resolved config as the engine builds it, which is the
 * encoded side, as with `runAction`. `runMode` defaults to "live".
 * `credentials` stands in for the Connection a node was configured with, and
 * a case that passes none runs the action the way a node with no Connection
 * does. `replay` answers a `step.run` whose id it holds with that value
 * without running the work, which is how a case checks that a retried pass
 * does not repeat a side effect.
 *
 * A handler that throws fails the node, so its message is in `result`, and
 * the promise still resolves. It rejects only for a defect in the boundary.
 */
export async function runHostAction(
  action: ActionDefinition,
  run: {
    readonly input: Readonly<Record<string, unknown>>;
    readonly runMode?: "live" | "test" | undefined;
    readonly credentials?:
      | Readonly<Record<string, string | undefined>>
      | undefined;
    readonly replay?: Readonly<Record<string, unknown>> | undefined;
    readonly node?: NodeUnderTest | undefined;
  }
): Promise<HostActionRun> {
  const steps: RecordedStep[] = [];
  const replay = run.replay ?? {};
  const recording: NodeSteps = {
    run: async (stepId, work) => {
      if (Object.hasOwn(replay, stepId)) {
        steps.push({
          id: stepId,
          replayed: true,
          ok: true,
          value: replay[stepId],
        });
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the case supplies what the step stored, as the executor's memo does
        return replay[stepId] as Awaited<ReturnType<typeof work>>;
      }
      try {
        const value = await work();
        steps.push({ id: stepId, replayed: false, ok: true, value });
        return value;
      } catch (error) {
        steps.push({
          id: stepId,
          replayed: false,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    runHandler: (work) => work(),
  };

  const step = action.implement({
    credentialsFor: () => toCredentialEffect(run.credentials),
  });
  const result = await Effect.runPromise(
    step(
      {
        ...run.input,
        integrationId:
          run.credentials === undefined ? undefined : TEST_INTEGRATION_ID,
        _context: {
          runMode: run.runMode ?? "live",
          nodeId: run.node?.nodeId ?? "node_1",
          nodeName: run.node?.nodeName ?? action.label,
          nodeType: run.node?.nodeType ?? "action",
          executionId: run.node?.executionId ?? TEST_EXECUTION_ID,
        },
      },
      recording
    )
  );
  return { result, steps };
}

/**
 * The payload of a step that did its work.
 *
 * It throws rather than narrows, so a step that unexpectedly gave up fails the
 * case with the reason it gave, which is what flipping an Effect used to do.
 */
export function actionData<TData>(result: StepResult<TData>): TData;
export function actionData(result: StepResult): unknown {
  if (!result.success) {
    throw new Error(
      `Expected the action to answer with data, and it gave up: ${result.error.message}`
    );
  }

  return result.data;
}

/** The reason a step gave up. It throws for a step that did its work instead. */
export function actionError(result: StepResult): StepError {
  if (result.success) {
    throw new Error(
      "Expected the action to give up, and it answered with data."
    );
  }

  return result.error;
}

function toCredentialEffect(
  supplied: SuppliedCredentials | undefined
): Effect.Effect<WorkflowCredentials, CredentialsUnavailable> {
  if (supplied === undefined) {
    return Effect.succeed({});
  }

  return Effect.isEffect(supplied) ? supplied : Effect.succeed({ ...supplied });
}
