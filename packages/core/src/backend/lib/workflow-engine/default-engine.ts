import {
  executeWorkflowCore,
  type WorkflowExecutionInput,
  type WorkflowExecutionRuntime,
} from "./core";
import type { WorkflowExecutionEngine } from "./types";

export class DefaultWorkflowExecutionEngine implements WorkflowExecutionEngine {
  execute(input: WorkflowExecutionInput, runtime?: WorkflowExecutionRuntime) {
    return executeWorkflowCore(input, runtime);
  }
}
