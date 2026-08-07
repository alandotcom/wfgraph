import { describe, expect, it, vi } from "vitest";
import { executeWorkflowRun } from "#src/lib/workflow-run-actions";
import type { WorkflowExecuteResult } from "#src/lib/rpc-client";

vi.mock("sonner", () => ({
  toast: { message: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

/**
 * `executeWorkflowRun` used to write the new run's id straight into the
 * selection atom. The Runs panel reads only the `executionId` search param, so
 * that write was invisible to it (#33). The URL is now the one writer: a
 * started run navigates there, and the branches that started nothing leave the
 * URL exactly where it stood.
 */
describe("executeWorkflowRun", () => {
  function baseParams(
    overrides: Partial<Parameters<typeof executeWorkflowRun>[0]> = {}
  ) {
    return {
      runWorkflow: vi.fn(),
      nodes: [],
      updateNodeData: vi.fn(),
      setIsExecuting: vi.fn(),
      navigateToExecution: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it("navigates to the new run once the engine confirms it started", async () => {
    const navigateToExecution = vi.fn(async () => {});
    const runWorkflow = vi.fn(
      async (): Promise<WorkflowExecuteResult> => ({
        status: "running",
        executionId: "exec_123",
        runMode: "live",
      })
    );

    await executeWorkflowRun(baseParams({ runWorkflow, navigateToExecution }));

    expect(navigateToExecution).toHaveBeenCalledExactlyOnceWith("exec_123");
  });

  // MAINTAINER DECISION (#33): an ignored run created no execution, so there is
  // no id for the URL to own. Whatever run was already open — or not — stays
  // open, rather than being cleared.
  it("leaves the URL alone when the run was ignored", async () => {
    const navigateToExecution = vi.fn(async () => {});
    const runWorkflow = vi.fn(
      async (): Promise<WorkflowExecuteResult> => ({
        status: "ignored",
        runMode: "live",
        reason: "workflow_paused",
      })
    );

    await executeWorkflowRun(baseParams({ runWorkflow, navigateToExecution }));

    expect(navigateToExecution).not.toHaveBeenCalled();
  });

  // Same decision, the other branch that starts nothing: the mutation itself
  // failed, so there is likewise no new execution for the URL to point at.
  it("leaves the URL alone when the run request fails", async () => {
    const navigateToExecution = vi.fn(async () => {});
    const runWorkflow = vi.fn(async (): Promise<WorkflowExecuteResult> => {
      throw new Error("network error");
    });

    await executeWorkflowRun(baseParams({ runWorkflow, navigateToExecution }));

    expect(navigateToExecution).not.toHaveBeenCalled();
  });
});
