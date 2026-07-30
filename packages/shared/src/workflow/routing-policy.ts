import { Schema } from "effect";
import { readAs } from "#src/types/schema";

/**
 * The Routing Policy: the retired per-event verb table (ADR 0001).
 *
 * Nothing on an intake path reads it. What is left is the shape the editor's old
 * trigger panel still writes and the graph schema still accepts, so a saved graph
 * keeps decoding until the Lifecycle panel replaces that panel. ADR-0007 is the
 * model now: which Events start a run and which cancel it is the Workflow
 * Builder's declaration on the Lifecycle Node.
 */
export const ROUTING_ACTIONS = [
  "start",
  "replace",
  "cancel",
  "ignore",
] as const;

export type RoutingAction = (typeof ROUTING_ACTIONS)[number];

export type RoutingPolicy = Record<string, RoutingAction>;

/**
 * The key rule sits in a check rather than in the key schema, because a check
 * on a key schema tells `Schema.Record` which properties to *select*: an empty
 * Event Type would be quietly dropped and the rest of the policy would read as
 * valid. A policy the editor could not have written is malformed, not partly
 * usable, so the whole record has to fail.
 */
export const routingPolicySchema = Schema.Record(
  Schema.String,
  Schema.Literals(ROUTING_ACTIONS)
).check(Schema.isPropertyNames(Schema.String.check(Schema.isMinLength(1))));

const readPolicy = readAs(routingPolicySchema);

/**
 * Reads the `routingPolicy` key off a trigger node's config. A config whose
 * policy fails the schema counts as no policy at all, which resolves every
 * Event Type to `ignore` — a misconfigured workflow does nothing rather than
 * guessing.
 */
export function readRoutingPolicy(
  config: Record<string, unknown> | undefined
): RoutingPolicy | undefined {
  return readPolicy(config?.routingPolicy);
}

/** True when at least one Event Type can produce a run. */
export function policyCanTrigger(policy: RoutingPolicy | undefined): boolean {
  return Object.values(policy ?? {}).some(
    (action) => action === "start" || action === "replace"
  );
}
