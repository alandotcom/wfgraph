/**
 * Register project-specific workflow triggers here.
 *
 * Quick guide for adding a new trigger:
 * 1. Add a trigger definition in `src/shared/workflow/triggers/<name>-trigger.ts`.
 * 2. Register it from this function with `registerWorkflowTrigger(createTrigger(...))`.
 * 3. If it should appear as a first-class trigger in the editor:
 *    - Add/extend config validation in `src/shared/workflow/schemas.ts`.
 *    - Add UI fields in `src/components/workflow/config/trigger-config.tsx`.
 * 4. If it accepts inbound events (webhooks, queues, etc.), use
 *    `executionType: "webhook"` and return routing decisions from `evaluate(...)`.
 * 5. Add tests in `src/shared/workflow/trigger-registry.test.ts` and any trigger-specific test file.
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
