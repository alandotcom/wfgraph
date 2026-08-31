/**
 * Dispatch port for the workflow engine.
 *
 * How the engine reaches an action's implementation, and what it may say about
 * one. Everything a host passed to `createWfGraphApp` carries its own
 * implementation into the assembled surface -- an integration's actions through
 * `defineStep`, a host's own through `defineAction`, the engine's two through
 * the same `defineStep` -- and the app turns that surface into one of these. The
 * engine module never reads the surface itself, the way it never reads a
 * database row.
 *
 * Sibling ports: `WorkflowStore` in ./store covers persistence and
 * `WorkflowExecutionRuntime` in ./runtime covers durability.
 */

import type { Effect } from "effect";
import type {
  NodeSteps,
  StepResult,
} from "@wfgraph/shared/actions/step-result";
import type { EngineFailure } from "#src/backend/engine/engine-failure";
import type { TemplateJsonShape } from "@wfgraph/shared/plugins/action-fields";

/** What the catalog says about an action, as the run needs it. */
export type ActionRunMetadata = {
  /**
   * The label the catalog gives an action, which a run log names an unlabelled
   * node with, so a run reads the way the editor does.
   */
  label: string;
  /**
   * The config keys the action declared `literal`, whose values reach the step
   * as the builder typed them rather than through template resolution.
   */
  literalConfigKeys: readonly string[];
  /**
   * The config keys whose value is JSON holding authored templates, each with
   * the layout its text is in. The engine resolves those value by value, so an
   * authored `"` or newline cannot break the JSON around it, and it dispatches
   * on the declared shape rather than guessing which one a string holds.
   */
  templateJsonConfigShapes: ReadonlyArray<[string, TemplateJsonShape]>;
};

/** An assembled action in the Effect-native shape the engine dispatches. */
export type WorkflowAction = (
  input: Record<string, unknown>,
  steps?: NodeSteps
) => Effect.Effect<StepResult, EngineFailure>;

export type WorkflowActions = {
  /** The step for an action id, or undefined when nothing was assembled with it. */
  stepFor: (actionType: string) => WorkflowAction | undefined;
  /** What the catalog holds for an action, or undefined for one it never heard of. */
  metadataFor: (actionType: string) => ActionRunMetadata | undefined;
  /**
   * Fingerprint of the live assembled catalog. Compared against the version a
   * run pinned at publish so a deploy that changes the surface fails the node
   * rather than resolving against a different set of actions.
   */
  catalogFingerprint: () => string;
};

/**
 * A surface holding nothing, which reports every action as unknown, for a test
 * whose graph reaches no action node. `executeWorkflow` requires a surface, so
 * nothing reaches this by omission.
 */
export const noWorkflowActions: WorkflowActions = {
  stepFor: () => undefined,
  metadataFor: () => undefined,
  catalogFingerprint: () => "",
};
