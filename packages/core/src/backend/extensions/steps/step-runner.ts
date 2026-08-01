/**
 * What a step definition needs from the app it runs inside.
 *
 * A step is written as an Effect and called by the engine as a Promise, and two
 * things about that conversion belong to the app: the credentials of whichever
 * integration a node named, and the runtime the whole step runs on. So
 * `implement` answers a factory and the app supplies both where it builds the
 * engine's action port, which is the first point holding the assembled surface,
 * the credential store behind it, and the runtime.
 *
 * A handler's Effect still asks for nothing an app provides, since `defineStep`
 * provides the vendor transport itself. What running on the app's runtime buys
 * is that the credential read is part of the step's own Effect rather than a
 * second runtime run beside it, so its failure travels the error channel to
 * `runStep` instead of escaping as a defect.
 */

import type { Effect } from "effect";
import type {
  CredentialsUnavailable,
  WorkflowCredentials,
} from "#src/backend/extensions/credential-fetcher";
import type { StepFunction } from "@rova/shared/actions/step-result";

export type StepEnvironment = {
  /** An integration's stored secrets, read at the moment the handler asks. */
  readonly credentialsFor: (
    integrationId: string
  ) => Effect.Effect<WorkflowCredentials, CredentialsUnavailable>;
  /**
   * Runs the assembled step, and is where a typed failure it could not answer
   * for becomes a rejected promise.
   *
   * The engine closes the node's run-log row on that rejection and records the
   * node failed, so a credential store that refused the read fails the node the
   * once. Everything a step can answer for -- a config the schema refuses, a
   * vendor that said no -- is already the `StepResult` envelope by the time this
   * is called, and fails the node the same way.
   *
   * An app runs the step to completion, uninterrupted, and a shutdown waits it
   * out: a handler that lost its answer partway would be run again by that
   * retry, sending a second SMS to record the first. `createWorkflowActions` is
   * where that is arranged.
   */
  readonly runStep: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
};

/** A step, once the app has said what it runs inside. */
export type StepFactory = (app: StepEnvironment) => StepFunction;
