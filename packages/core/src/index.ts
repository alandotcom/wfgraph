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
