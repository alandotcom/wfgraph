/**
 * Workflow execution entrypoint.
 * Engine implementation lives under workflow-engine modules.
 */

import type {
  WorkflowExecutionInput,
  WorkflowExecutionRuntime,
} from "@/backend/lib/workflow-engine/core";
import { DefaultWorkflowExecutionEngine } from "@/backend/lib/workflow-engine/default-engine";
import type { WorkflowExecutionEngine } from "@/backend/lib/workflow-engine/types";

export type {
  WorkflowExecutionInput,
  WorkflowExecutionRuntime,
} from "@/backend/lib/workflow-engine/core";
export { executeWorkflowCore } from "@/backend/lib/workflow-engine/core";

const defaultWorkflowExecutionEngine = new DefaultWorkflowExecutionEngine();

export function executeWorkflow(
  input: WorkflowExecutionInput,
  runtime?: WorkflowExecutionRuntime,
  engine: WorkflowExecutionEngine = defaultWorkflowExecutionEngine
) {
  return engine.execute(input, runtime);
}
