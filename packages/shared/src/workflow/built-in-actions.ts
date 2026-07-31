/**
 * The two action ids the engine ships itself.
 *
 * They cross three packages, the wire and every saved node's config, so they are
 * named here rather than written out at each reader. Changing a literal in one
 * of those readers type-checks and silently stops the engine routing to the Wait
 * step, or stops a Wait node reaching the subscription index.
 */
export const BUILT_IN_ACTION_IDS = {
  condition: "Condition",
  wait: "Wait",
} as const;
