// biome-ignore lint/performance/noBarrelFile: Public library entrypoint intentionally re-exports API.
export {
  type RovaServerHandle,
  type RovaServerStartOptions,
  server,
  startRovaServer,
} from "@/rova/server";
export {
  type ActionPayloadSchema,
  type CreateActionInput,
  createAction,
  type RuntimeExtensionActionDefinition,
} from "@/shared/workflow/action-registry";
export {
  type CreateTriggerInput,
  createTrigger,
  type RuntimeExtensionTriggerDefinition,
  type TriggerPayloadSchema,
} from "@/shared/workflow/trigger-registry";
