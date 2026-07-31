/**
 * What a step definition needs from the app it runs inside.
 *
 * A step is written as an Effect and called by the engine as a Promise, and the
 * one thing that conversion needs from outside the definition is the credentials
 * of whichever integration a node named. So `implement` answers a factory and
 * the app supplies this where it builds the engine's action port, which is the
 * first point holding both the assembled surface and the credential store behind
 * it.
 *
 * A handler's Effect asks for nothing the app provides -- `defineStep` provides
 * the vendor transport itself and turns every failure into the envelope -- so
 * `defineStep` runs it with `Effect.runPromise` rather than on the app's
 * runtime. The runtime belongs here the day a handler may yield an app service,
 * which is the day the type changes anyway.
 */

import type { Effect } from "effect";
import type { WorkflowCredentials } from "#src/backend/extensions/credential-fetcher";
import type { StepFunction } from "@rova/shared/actions/step-result";

export type StepEnvironment = {
  /** An integration's stored secrets, read at the moment the handler asks. */
  readonly credentialsFor: (
    integrationId: string
  ) => Effect.Effect<WorkflowCredentials>;
};

/** A step, once the app has said what it runs inside. */
export type StepFactory = (app: StepEnvironment) => StepFunction;
