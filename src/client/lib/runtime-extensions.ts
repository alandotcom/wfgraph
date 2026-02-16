import {
  type ActionConfigField,
  clearRuntimeActions,
  type RuntimeActionDefinition,
  registerRuntimeAction,
} from "@/plugins";

export type RuntimeTriggerDefinition = {
  type: string;
  label: string;
  executionType: "manual" | "webhook";
  description?: string;
  configFields?: ActionConfigField[];
};

type RuntimeExtensionsPayload = {
  actions?: RuntimeActionDefinition[];
  triggers?: RuntimeTriggerDefinition[];
};

const runtimeTriggerRegistry = new Map<string, RuntimeTriggerDefinition>();

let hydrationPromise: Promise<void> | null = null;

export function getRuntimeTriggers(): RuntimeTriggerDefinition[] {
  return Array.from(runtimeTriggerRegistry.values());
}

export function hydrateRuntimeExtensionsFromApi(): Promise<void> {
  if (hydrationPromise) {
    return hydrationPromise;
  }

  hydrationPromise = (async () => {
    try {
      const response = await fetch("/api/extensions", {
        method: "GET",
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RuntimeExtensionsPayload;

      clearRuntimeActions();
      runtimeTriggerRegistry.clear();

      for (const action of payload.actions ?? []) {
        if (!(action?.id && action.label)) {
          continue;
        }
        registerRuntimeAction(action);
      }

      for (const trigger of payload.triggers ?? []) {
        if (!(trigger?.type && trigger.label)) {
          continue;
        }

        runtimeTriggerRegistry.set(trigger.type, trigger);
      }
    } catch {
      // Runtime extensions are optional.
    }
  })();

  return hydrationPromise;
}
