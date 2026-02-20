/**
 * Register project-specific workflow triggers here.
 *
 * Quick guide for adding a new trigger:
 * 1. Add a trigger definition in `src/shared/workflow/triggers/<name>-trigger.ts`.
 * 2. Register it from this function with `registerWorkflowTrigger(createTrigger(...))`.
 * 3. If it should appear as a first-class trigger in the editor:
 *    - Add/extend config validation in `src/shared/workflow/schemas.ts`.
 *    - Add UI fields in `src/components/workflow/config/trigger-config.tsx`.
 * 4. Extension triggers are webhook-trigger only. Provide a strict payload schema,
 *    `correlationIdPath`, and lifecycle callbacks (`onStart`, `onRestart`, `onStop`).
 * 5. Add tests in `src/shared/workflow/trigger-registry.test.ts` and any trigger-specific test file.
 *
 * Example:
 * registerWorkflowTrigger(
 *   createTrigger({
 *     type: "MyTrigger",
 *     label: "My Trigger",
 *     schema: z.object({
 *       event: z.enum(["entity.created", "entity.updated", "entity.deleted"]),
 *       entity: z.object({ id: z.string() }),
 *     }),
 *     correlationIdPath: "entity.id",
 *     lifecycle: {
 *       onStart: ({ payload }) => payload.event === "entity.created",
 *       onRestart: ({ payload }) => payload.event === "entity.updated",
 *       onStop: ({ payload }) => payload.event === "entity.deleted",
 *     },
 *   })
 * );
 */
export function registerCustomWorkflowTriggers() {
  // Register project-specific custom triggers here.
}
