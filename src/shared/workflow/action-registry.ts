import type { ActionConfigField, OutputField } from "@/plugins/registry";

export type RuntimeActionExecuteInput = Record<string, unknown>;

export type RuntimeActionResult =
  | { success: true; data?: unknown }
  | { success: false; error?: string | { message?: string } }
  | Record<string, unknown>;

export type RuntimeActionDefinition = {
  id: string;
  label: string;
  description: string;
  category?: string;
  configFields?: ActionConfigField[];
  outputFields?: OutputField[];
  execute: (
    input: RuntimeActionExecuteInput
  ) => RuntimeActionResult | Promise<RuntimeActionResult>;
};

export type RuntimeActionMetadata = Omit<RuntimeActionDefinition, "execute">;

const runtimeActionRegistry = new Map<string, RuntimeActionDefinition>();

export function createAction(
  definition: RuntimeActionDefinition
): RuntimeActionDefinition {
  return {
    ...definition,
    category: definition.category?.trim() || "Custom",
  };
}

export function registerRuntimeAction(
  definition: RuntimeActionDefinition
): void {
  runtimeActionRegistry.set(definition.id, createAction(definition));
}

export function getRuntimeAction(
  actionId: string
): RuntimeActionDefinition | undefined {
  return runtimeActionRegistry.get(actionId);
}

export function listRuntimeActions(): RuntimeActionMetadata[] {
  return Array.from(runtimeActionRegistry.values()).map(
    ({ execute: _execute, ...metadata }) => metadata
  );
}
