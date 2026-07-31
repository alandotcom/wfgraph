/**
 * The one entry point a host imports to embed Rova: the authoring vocabulary
 * (`defineEvent`, `defineAction`), `createRovaApp`, and `createRequestListener`
 * for mounting on node:http. A package of integrations builds against
 * `@rova/core/plugin` instead, and `@rova/core/migrate` applies migrations
 * without building an app.
 */

export {
  defineEvent,
  type EventDefinition,
} from "#src/backend/lib/extensions/define-event";
// The Event-facing name for a payload path resolving to a string, which is what
// a Correlation Path may be.
export type { StringPath as EventStringPath } from "@rova/shared/types/payload-path";
export {
  type ActionDefinition,
  type ActionRunContext,
  defineAction,
} from "#src/backend/lib/extensions/define-action";

export {
  createRovaApp,
  type DatabaseRuntimeConfig,
  type EncryptionRuntimeConfig,
  type MigrationsOptions,
  type RovaApp,
  type RovaAppOptions,
  type RovaAuth,
  type RovaClientBundle,
  type RovaDatabaseOptions,
  type RovaExtensions,
  type RovaInngestConfig,
  type RovaLogger,
} from "#src/app";

export {
  createRequestListener,
  type CreateRequestListenerOptions,
  type RovaRequestListener,
} from "#src/node";
