import {
  type ActionConfigField,
  clearRuntimeActions,
  type RuntimeActionDefinition,
  registerRuntimeAction,
} from "@/plugins";
import {
  isWebhookSchemaField,
  type WebhookSchemaField,
} from "@/shared/workflow/webhook-field-registry";

export type RuntimeTriggerDefinition = {
  type: string;
  label: string;
  executionType: "manual" | "webhook";
  description?: string;
  logoUrl?: string;
  configFields?: ActionConfigField[];
  conditionSchema?: WebhookSchemaField[];
};

type RuntimeExtensionsPayload = {
  actions?: RuntimeActionDefinition[];
  triggers?: RuntimeTriggerDefinition[];
};

const runtimeTriggerRegistry = new Map<string, RuntimeTriggerDefinition>();

let hydrationPromise: Promise<void> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRuntimeActionDefinition(
  value: unknown
): value is RuntimeActionDefinition {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.id !== "string" ||
    typeof value.label !== "string" ||
    typeof value.description !== "string" ||
    typeof value.category !== "string"
  ) {
    return false;
  }

  if (
    "logoUrl" in value &&
    value.logoUrl !== undefined &&
    typeof value.logoUrl !== "string"
  ) {
    return false;
  }

  if (
    "integration" in value &&
    value.integration !== undefined &&
    typeof value.integration !== "string"
  ) {
    return false;
  }

  if (
    "configFields" in value &&
    value.configFields !== undefined &&
    !Array.isArray(value.configFields)
  ) {
    return false;
  }

  if (
    "outputFields" in value &&
    value.outputFields !== undefined &&
    !Array.isArray(value.outputFields)
  ) {
    return false;
  }

  return true;
}

function isRuntimeTriggerDefinition(
  value: unknown
): value is RuntimeTriggerDefinition {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.type !== "string" ||
    typeof value.label !== "string" ||
    (value.executionType !== "manual" && value.executionType !== "webhook")
  ) {
    return false;
  }

  if (
    "description" in value &&
    value.description !== undefined &&
    typeof value.description !== "string"
  ) {
    return false;
  }

  if (
    "logoUrl" in value &&
    value.logoUrl !== undefined &&
    typeof value.logoUrl !== "string"
  ) {
    return false;
  }

  if (
    "configFields" in value &&
    value.configFields !== undefined &&
    !Array.isArray(value.configFields)
  ) {
    return false;
  }

  if (
    "conditionSchema" in value &&
    value.conditionSchema !== undefined &&
    !(
      Array.isArray(value.conditionSchema) &&
      value.conditionSchema.every((field) => isWebhookSchemaField(field))
    )
  ) {
    return false;
  }

  return true;
}

function parseRuntimeExtensionsPayload(
  value: unknown
): RuntimeExtensionsPayload {
  if (!isRecord(value)) {
    return {};
  }

  return {
    actions: Array.isArray(value.actions)
      ? value.actions.filter(isRuntimeActionDefinition)
      : undefined,
    triggers: Array.isArray(value.triggers)
      ? value.triggers.filter(isRuntimeTriggerDefinition)
      : undefined,
  };
}

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

      const payload = parseRuntimeExtensionsPayload(await response.json());

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
