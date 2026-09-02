/**
 * Running one action of an integration, the way a workflow runs it.
 *
 * A separate entry from `@wfgraph/core/plugin` because nothing here runs in a
 * server: an integration's own suite imports it, and a server bundle never
 * reaches it. What it drives is the whole boundary `defineIntegration` builds,
 * so a case sees the config decode, the credential fetch, the handler, the
 * output encode and the envelope, rather than the handler alone.
 */

import { Effect } from "effect";
import type {
  CredentialsUnavailable,
  WorkflowCredentials,
} from "#src/backend/extensions/credential-fetcher";
import type { Integration } from "#src/backend/extensions/define-integration";
import type { ActionStep } from "#src/backend/extensions/steps/define-step";
import type { StepEnvironment } from "#src/backend/extensions/steps/step-runner";
import { formatActionId } from "@wfgraph/shared/extensions/catalog";
import type {
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
 * value, which is also what the engine memoizes and the run panel shows.
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
      executionId: run.node?.executionId,
    },
  });
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
