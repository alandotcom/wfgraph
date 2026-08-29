import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  executeWorkflowRun,
  shouldRunDraftGraph,
  updateNodesStatus,
} from "#src/lib/workflow-run-actions";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import type { WorkflowExecuteResult } from "#src/lib/rpc-client";

beforeEach(() => {
  vi.spyOn(toast, "message").mockImplementation(() => "id" as never);
  vi.spyOn(toast, "error").mockImplementation(() => "id" as never);
  vi.spyOn(toast, "success").mockImplementation(() => "id" as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lifecycleNode(id: string): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: id, type: "lifecycle" },
  };
}

function actionNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action" },
  };
}

/**
 * Status animation writes into `statusByNodeIdAtom` through the batch
 * `setNodeStatuses` writer, never `updateNodeData` -- a status is never part
 * of a node's own data. These tests stand on that boundary directly, with a
 * spy in place of the atom.
 */
describe("updateNodesStatus", () => {
  it("sets every node to the given status in one batched call", () => {
    const setNodeStatuses = vi.fn();
    const nodes = [lifecycleNode("t"), actionNode("a")];

    updateNodesStatus(nodes, setNodeStatuses, "idle");

    expect(setNodeStatuses).toHaveBeenCalledTimes(1);
    expect(setNodeStatuses).toHaveBeenCalledWith([
      { nodeId: "t", status: "idle" },
      { nodeId: "a", status: "idle" },
    ]);
  });
});

/**
 * The Run button's draft-vs-published decision: test mode and a signal saying
 * the draft is ahead of (or entirely without) a published version.
 */
describe("shouldRunDraftGraph", () => {
  it("never runs the draft for a live workflow, however stale published is", () => {
    expect(
      shouldRunDraftGraph({
        workflowMode: "live",
        publication: { isPublished: false, hasUnpublishedChanges: true },
      })
    ).toBe(false);
  });

  it("runs the draft in test mode when the workflow has never been published", () => {
    expect(
      shouldRunDraftGraph({
        workflowMode: "test",
        publication: { isPublished: false, hasUnpublishedChanges: false },
      })
    ).toBe(true);
  });

  it("runs the draft in test mode when the canvas has moved past published", () => {
    expect(
      shouldRunDraftGraph({
        workflowMode: "test",
        publication: { isPublished: true, hasUnpublishedChanges: true },
      })
    ).toBe(true);
  });

  it("runs published in test mode once the draft matches it", () => {
    expect(
      shouldRunDraftGraph({
        workflowMode: "test",
        publication: { isPublished: true, hasUnpublishedChanges: false },
      })
    ).toBe(false);
  });

  // The publication signal rides the same `getById` entry every other piece of
  // toolbar state reads, so an unloaded one reads as "nothing published yet"
  // rather than as a reason to guess published.
  it("treats an unloaded publication signal as never published", () => {
    expect(
      shouldRunDraftGraph({ workflowMode: "test", publication: undefined })
    ).toBe(true);
  });
});

/**
 * `executeWorkflowRun` used to write the new run's id straight into the
 * selection atom. The Runs panel reads only the `executionId` search param, so
 * that write was invisible to it (#33). The URL is now the one writer: a
 * started run navigates there, and the branches that started nothing leave the
 * URL exactly where it stood.
 */
describe("executeWorkflowRun", () => {
  const runningResult: WorkflowExecuteResult = {
    status: "running",
    executionId: "exec_1",
    runMode: "live",
  };

  function baseParams(
    overrides: Partial<Parameters<typeof executeWorkflowRun>[0]> = {}
  ) {
    return {
      runWorkflow: vi.fn(
        async (): Promise<WorkflowExecuteResult> => runningResult
      ),
      nodes: [] as WorkflowNode[],
      setNodeStatuses: vi.fn(),
      setIsExecuting: vi.fn(),
      navigateToExecution: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it("marks every node idle, then only the Lifecycle Node running, before the run resolves", async () => {
    const setNodeStatuses = vi.fn();
    const nodes = [lifecycleNode("t"), actionNode("a")];

    await executeWorkflowRun(baseParams({ nodes, setNodeStatuses }));

    // Instant feedback happens before the mutation is awaited: reset first,
    // then show the entrypoint moving, both ahead of any server answer.
    expect(setNodeStatuses).toHaveBeenNthCalledWith(1, [
      { nodeId: "t", status: "idle" },
      { nodeId: "a", status: "idle" },
    ]);
    expect(setNodeStatuses).toHaveBeenNthCalledWith(2, [
      { nodeId: "t", status: "running" },
    ]);
  });

  it("navigates to the new run once the engine confirms it started", async () => {
    const navigateToExecution = vi.fn(async () => {});

    await executeWorkflowRun(
      baseParams({ nodes: [lifecycleNode("t")], navigateToExecution })
    );

    expect(navigateToExecution).toHaveBeenCalledExactlyOnceWith("exec_1");
  });

  // MAINTAINER DECISION (#33): an ignored run created no execution, so there is
  // no id for the URL to own. Whatever run was already open -- or not -- stays
  // open, rather than being cleared.
  it("resets every node to idle and leaves the URL alone when the run was ignored", async () => {
    const setNodeStatuses = vi.fn();
    const setIsExecuting = vi.fn();
    const navigateToExecution = vi.fn(async () => {});
    const runWorkflow = vi.fn(async (): Promise<WorkflowExecuteResult> => ({
      status: "ignored",
      runMode: "live",
      reason: "workflow_paused",
    }));

    await executeWorkflowRun(
      baseParams({
        runWorkflow,
        nodes: [lifecycleNode("t")],
        setNodeStatuses,
        setIsExecuting,
        navigateToExecution,
      })
    );

    expect(setNodeStatuses).toHaveBeenLastCalledWith([
      { nodeId: "t", status: "idle" },
    ]);
    expect(navigateToExecution).not.toHaveBeenCalled();
    expect(setIsExecuting).toHaveBeenCalledWith(false);
  });

  // Same decision, the other branch that starts nothing: the mutation itself
  // failed, so there is likewise no new execution for the URL to point at.
  it("marks every node error and leaves the URL alone when the run mutation rejects", async () => {
    const setNodeStatuses = vi.fn();
    const setIsExecuting = vi.fn();
    const navigateToExecution = vi.fn(async () => {});
    const runWorkflow = vi.fn(async (): Promise<WorkflowExecuteResult> => {
      throw new Error("boom");
    });

    await executeWorkflowRun(
      baseParams({
        runWorkflow,
        nodes: [lifecycleNode("t"), actionNode("a")],
        setNodeStatuses,
        setIsExecuting,
        navigateToExecution,
      })
    );

    expect(setNodeStatuses).toHaveBeenLastCalledWith([
      { nodeId: "t", status: "error" },
      { nodeId: "a", status: "error" },
    ]);
    expect(navigateToExecution).not.toHaveBeenCalled();
    expect(setIsExecuting).toHaveBeenLastCalledWith(false);
  });
});
