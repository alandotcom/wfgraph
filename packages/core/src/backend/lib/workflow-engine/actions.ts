/**
 * Dispatch port for the workflow engine.
 *
 * How the engine reaches an action's implementation, and what it may say about
 * one. Everything a host passed to `createRovaApp` carries its own
 * implementation into the assembled surface -- an integration's actions through
 * `defineStep`, a host's own through `createAction`, the engine's two through
 * the same `defineStep` -- and the app turns that surface into one of these. The
 * engine module never reads the surface itself, the way it never reads a
 * database row.
 *
 * Sibling ports: `WorkflowStore` in ./store covers persistence and
 * `WorkflowExecutionRuntime` in ./runtime covers durability.
 */

import type { StepFunction } from "@rova/shared/workflow/step-result";

export type WorkflowActions = {
  /** The step for an action id, or undefined when nothing was assembled with it. */
  stepFor: (actionType: string) => StepFunction | undefined;
  /**
   * The label the catalog gives an action, which a run log names an unlabelled
   * node with, so a run reads the way the editor does.
   */
  labelFor: (actionType: string) => string | undefined;
  /** The ids the engine ships itself, which an unknown action's message lists. */
  systemActionIds: readonly string[];
};

/**
 * A surface holding nothing, which reports every action as unknown.
 *
 * The honest default for a caller with no assembled surface, matching
 * `noopWorkflowStore`: a run against it reaches every node and fails each one
 * by name rather than pretending to have done the work.
 */
export const noWorkflowActions: WorkflowActions = {
  stepFor: () => undefined,
  labelFor: () => undefined,
  systemActionIds: [],
};
