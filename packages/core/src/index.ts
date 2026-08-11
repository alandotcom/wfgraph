/**
 * The one entry point a host imports to embed Workflow Graph: the authoring vocabulary
 * (`defineEvent`, `defineAction`), `createWfGraphApp`, and `createRequestListener`
 * for mounting on node:http. A package of integrations builds against
 * `@wfgraph/core/plugin` instead, and `@wfgraph/core/migrate` applies migrations
 * without building an app.
 */

export {
  defineEvent,
  type EventDefinition,
} from "#src/backend/extensions/define-event";
// The Event-facing name for a payload path resolving to a string, which is what
// a Correlation Path may be.
export type { StringPath as EventStringPath } from "@wfgraph/shared/types/payload-path";
export {
  type ActionBag,
  type ActionDefinition,
  defineAction,
} from "#src/backend/extensions/define-action";
/**
 * How a handler written as an `Effect` fails its node, with the message the run
 * log shows. A handler written as a plain function throws instead.
 */
export { StepFailure } from "#src/backend/extensions/steps/define-step";

export {
  createWfGraphApp,
  type EncryptionRuntimeConfig,
  type WfGraphApp,
  type WfGraphAppOptions,
  type WfGraphAuth,
  type WfGraphClientBundle,
  type WfGraphExtensions,
  type WfGraphInngestConfig,
  type WfGraphLogger,
  type WfGraphPersistence,
} from "#src/app";

export {
  createRequestListener,
  type CreateRequestListenerOptions,
  type WfGraphRequestListener,
} from "#src/node";
