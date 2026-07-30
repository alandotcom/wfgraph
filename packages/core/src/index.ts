export {
  type AnyEventDefinition,
  defineEvent,
  type DefineEventInput,
  type EventDefinition,
  type PayloadSchema,
} from "#src/backend/lib/extensions/define-event";
export type { InngestEventOptions } from "#src/backend/lib/extensions/inngest-options";
// The Event-facing name for a payload path resolving to a string, which is what a
// Correlation Path may be. The type is the shared one the trigger surface uses.
export type { StringPath as EventStringPath } from "@rova/shared/types/payload-path";
export {
  type CreateActionInput,
  type CreateActionInputWithOutput,
  createAction,
  type InputSchema,
  type RuntimeExtensionActionDefinition,
  type TypedActionResult,
} from "@rova/shared/workflow/action-registry";
export type { OutputSchema } from "@rova/shared/workflow/output-fields";
export {
  type CreateTriggerInput,
  createTrigger,
  type RuntimeExtensionTriggerDefinition,
  type TriggerPayloadSchema,
} from "@rova/shared/workflow/trigger-registry";
