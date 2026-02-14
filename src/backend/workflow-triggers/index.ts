/**
 * Register project-specific workflow triggers here.
 *
 * Example:
 * registerWorkflowTrigger(
 *   createTrigger({
 *     type: "MyTrigger",
 *     label: "My Trigger",
 *     executionType: "manual",
 *     evaluate: ({ payload }) => ({
 *       triggerType: "MyTrigger",
 *       executionType: "manual",
 *       eventType: typeof payload.event === "string" ? payload.event : undefined,
 *       correlationKey: undefined,
 *       routingDecision: { kind: "start" },
 *     }),
 *   })
 * );
 */
export function registerCustomWorkflowTriggers() {
  // Register project-specific custom triggers here.
}
