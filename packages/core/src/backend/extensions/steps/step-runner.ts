/**
 * What a step definition needs from the app it runs inside.
 *
 * A step is written and dispatched as an Effect. The app supplies the
 * credentials of whichever integration a node named when it builds the
 * engine's action port; the outer Inngest handler runs the whole engine
 * invocation on the app runtime.
 */

import type { Effect } from "effect";
import type {
  CredentialsUnavailable,
  WorkflowCredentials,
} from "#src/backend/extensions/credential-fetcher";
import type {
  NodeSteps,
  StepResult,
} from "@wfgraph/shared/actions/step-result";

export type StepEnvironment = {
  /** An integration's stored secrets, read at the moment the handler asks. */
  readonly credentialsFor: (
    integrationId: string
  ) => Effect.Effect<WorkflowCredentials, CredentialsUnavailable>;
};

/** A step after the app has bound its credential store. */
export type StepEffect = (
  input: Record<string, unknown>,
  steps?: NodeSteps
) => Effect.Effect<StepResult, CredentialsUnavailable>;

/** A step, once the app has said what it runs inside. */
export type StepFactory = (app: StepEnvironment) => StepEffect;
