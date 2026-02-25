import type { WorkflowExecutionInput, WorkflowExecutionRuntime } from "./core";

export type {
  WorkflowExecutionInput,
  WorkflowExecutionRuntime,
} from "./core";

export type WorkflowExecutionResult = Awaited<
  ReturnType<WorkflowExecutionEngine["execute"]>
>;

export interface WorkflowExecutionEngine {
  execute(
    input: WorkflowExecutionInput,
    runtime?: WorkflowExecutionRuntime
  ): Promise<{
    success: boolean;
    results: Record<
      string,
      { success: boolean; data?: unknown; error?: string }
    >;
    outputs: Record<string, { label: string; data: unknown }>;
    error?: string;
    cancelled?: boolean;
  }>;
}
