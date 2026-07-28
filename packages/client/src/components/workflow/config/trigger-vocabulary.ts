import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { findRuntimeTrigger } from "#src/lib/runtime-extensions";
import { nodesAtom } from "#src/lib/workflow-graph-store";
import {
  readRoutingPolicy,
  type RoutingPolicy,
} from "@rova/shared/workflow/routing-policy";
import { buildWebhookRoutingConfig } from "@rova/shared/workflow/webhook-routing";

/**
 * What the editor knows about the workflow trigger's Event Type language,
 * assembled for consumers that live away from the trigger panel (the Wait
 * node's event picker, conflict warnings).
 */
export type TriggerVocabulary = {
  triggerType: string;
  /** The trigger node's id, so consumers can offer navigation to it. */
  triggerNodeId: string | undefined;
  /** The workflow's Routing Policy, straight from the trigger node config. */
  policy: RoutingPolicy | undefined;
  /**
   * The closed Event Type vocabulary, when the trigger has one. Undefined
   * means open: the webhook trigger, or a custom trigger whose
   * eventTypePath points at a plain string.
   */
  eventTypes: string[] | undefined;
  /** Event Types worth offering in pickers: the closed set, else policy keys. */
  knownEventTypes: string[];
  /** The payload path runs correlate on, for copy that explains matching. */
  correlationPath: string | undefined;
};

export function useTriggerVocabulary(): TriggerVocabulary {
  const nodes = useAtomValue(nodesAtom);

  return useMemo(() => {
    const triggerNode = nodes.find((node) => node.data.type === "trigger");
    const config = triggerNode?.data.config;
    const triggerNodeId = triggerNode?.id;
    const triggerType =
      typeof config?.triggerType === "string" && config.triggerType.trim()
        ? config.triggerType.trim()
        : "Webhook";
    const policy = readRoutingPolicy(config);

    if (triggerType === "Webhook") {
      return {
        triggerType,
        triggerNodeId,
        policy,
        eventTypes: undefined,
        knownEventTypes: Object.keys(policy ?? {}),
        // The same resolution the backend classifies with, defaults included,
        // so the path the editor names is the path runs correlate on.
        correlationPath: buildWebhookRoutingConfig(config).correlationPath,
      };
    }

    const runtimeTrigger = findRuntimeTrigger(triggerType);
    const eventTypes =
      runtimeTrigger?.eventTypes && runtimeTrigger.eventTypes.length > 0
        ? runtimeTrigger.eventTypes
        : undefined;
    return {
      triggerType,
      triggerNodeId,
      policy,
      eventTypes,
      knownEventTypes: eventTypes ?? Object.keys(policy ?? {}),
      correlationPath: runtimeTrigger?.correlationPath,
    };
  }, [nodes]);
}
