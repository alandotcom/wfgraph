import { z } from "zod";

/**
 * The Routing Policy is the Workflow Builder's per-workflow mapping from
 * Event Type to what happens when that payload arrives (see ADR 0001). The
 * trigger definition supplies vocabulary only; this module owns the policy
 * shape and its resolution.
 */
export const ROUTING_ACTIONS = [
  "start",
  "replace",
  "cancel",
  "ignore",
] as const;

export type RoutingAction = (typeof ROUTING_ACTIONS)[number];

export const routingPolicySchema = z.record(
  z.string().min(1),
  z.enum(ROUTING_ACTIONS)
);

export type RoutingPolicy = Record<string, RoutingAction>;

/**
 * What a trigger definition says about an incoming payload: vocabulary, not
 * policy. Defined here so classification and policy resolution share one
 * shape; `trigger-registry.ts` re-exports it as part of the trigger surface.
 */
export type TriggerClassification =
  | {
      ok: true;
      eventType: string | undefined;
      correlationKey: string | undefined;
    }
  | { ok: false; reason: "invalid_payload" };

/**
 * Reads the `routingPolicy` key off a trigger node's config. A config whose
 * policy fails the schema counts as no policy at all, which resolves every
 * Event Type to `ignore` — a misconfigured workflow does nothing rather than
 * guessing.
 */
export function readRoutingPolicy(
  config: Record<string, unknown> | undefined
): RoutingPolicy | undefined {
  const parsed = routingPolicySchema.safeParse(config?.routingPolicy);
  return parsed.success ? parsed.data : undefined;
}

/**
 * An unmapped Event Type means `ignore`: the Workflow Builder makes every
 * routing decision consciously, and a payload nobody asked about does
 * nothing. A payload with no Event Type can never match a mapping.
 */
export function resolveRoutingAction(
  policy: RoutingPolicy | undefined,
  eventType: string | undefined
): RoutingAction {
  if (!eventType) {
    return "ignore";
  }
  return policy?.[eventType] ?? "ignore";
}

/** True when at least one Event Type can produce a run. */
export function policyCanTrigger(policy: RoutingPolicy | undefined): boolean {
  return Object.values(policy ?? {}).some(
    (action) => action === "start" || action === "replace"
  );
}

export type TriggerRoutingIgnoreReason =
  | "invalid_payload"
  | "missing_event_type"
  | "event_not_mapped";

/**
 * The routing outcome, shaped so illegal combinations cannot exist: only an
 * ignore carries a reason, and every run-affecting action carries the Event
 * Type that selected it.
 */
export type ResolvedTriggerRouting =
  | {
      action: "ignore";
      ignoreReason: TriggerRoutingIgnoreReason;
      eventType: string | undefined;
      correlationKey: string | undefined;
    }
  | {
      action: Exclude<RoutingAction, "ignore">;
      eventType: string;
      correlationKey: string | undefined;
    };

/**
 * The one derivation every entrypoint (webhook, event listener, manual
 * execute) performs between classifying a payload and orchestrating: turn
 * the trigger's classification plus the workflow's policy into an action.
 */
export function resolveTriggerRouting(input: {
  classification: TriggerClassification;
  config: Record<string, unknown> | undefined;
}): ResolvedTriggerRouting {
  if (!input.classification.ok) {
    return {
      action: "ignore",
      ignoreReason: "invalid_payload",
      eventType: undefined,
      correlationKey: undefined,
    };
  }

  const { eventType, correlationKey } = input.classification;
  if (!eventType) {
    return {
      action: "ignore",
      ignoreReason: "missing_event_type",
      eventType,
      correlationKey,
    };
  }

  const action = resolveRoutingAction(
    readRoutingPolicy(input.config),
    eventType
  );
  if (action === "ignore") {
    return {
      action,
      ignoreReason: "event_not_mapped",
      eventType,
      correlationKey,
    };
  }

  return { action, eventType, correlationKey };
}
