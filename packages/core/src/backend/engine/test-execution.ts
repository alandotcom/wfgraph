import { Effect, Layer } from "effect";
import {
  executeWorkflow,
  executeWorkflowBranch,
  type WorkflowBranchInput,
  type WorkflowExecutionInput,
} from "#src/backend/engine/core";
import type { WorkflowActions } from "#src/backend/engine/actions";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import type { WorkflowStore } from "#src/backend/engine/store";
import { AppLoggerLayer } from "#src/backend/lib/effect/app-logger";
import { TracerBridgeLayer } from "#src/backend/lib/effect/tracer";

/** The observability services a production invocation gets from WfGraphRuntime. */
const EngineTestLayer = Layer.merge(AppLoggerLayer, TracerBridgeLayer);

export function executeTestWorkflow(
  input: Omit<
    WorkflowExecutionInput,
    "catalogFingerprint" | "workflowVersionId"
  > &
    Partial<
      Pick<WorkflowExecutionInput, "catalogFingerprint" | "workflowVersionId">
    >,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions
) {
  return Effect.runPromise(
    executeWorkflow(
      {
        // Match the live catalog by default so drift is opt-in for the cases
        // that assert it, rather than failing every host-action suite.
        catalogFingerprint: actions.catalogFingerprint(),
        workflowVersionId: "ver_test",
        ...input,
      },
      runtime,
      store,
      actions
    ).pipe(Effect.provide(EngineTestLayer))
  );
}

export function executeTestWorkflowBranch(
  input: Omit<WorkflowBranchInput, "catalogFingerprint" | "workflowVersionId"> &
    Partial<
      Pick<WorkflowBranchInput, "catalogFingerprint" | "workflowVersionId">
    >,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions
) {
  return Effect.runPromise(
    executeWorkflowBranch(
      {
        catalogFingerprint: actions.catalogFingerprint(),
        workflowVersionId: "ver_test",
        ...input,
      },
      runtime,
      store,
      actions
    ).pipe(Effect.provide(EngineTestLayer))
  );
}
