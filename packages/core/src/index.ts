/**
 * What a host writes its own vocabulary with: the Events its app sends, and the
 * actions its workflows can take. A package of integrations builds against
 * `@rova/core/plugin` instead, and `createRovaApp` is `@rova/core/app`.
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
  createAction,
} from "@rova/shared/workflow/action-registry";
/**
 * How a schema says a field is a moment in time. `@rova/shared` is private, so a
 * host reaches them here and a plugin author through `@rova/core/plugin`.
 */
export { dateField, timestampField } from "@rova/shared/types/timestamp";
