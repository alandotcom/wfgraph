import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { restoreCompletedNodeProgress } from "#src/backend/engine/branch-progress";
import { engineFailure } from "#src/backend/engine/engine-failure";
import { Traversal } from "#src/backend/engine/traversal";
import { resolveTemplateString } from "#src/backend/engine/templates";

function actionNode(id: string, label = id): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label, type: "action", config: {} },
  };
}

describe("restoreCompletedNodeProgress", () => {
  it("restores completed outputs and failed results from the run log", () => {
    const output = {
      success: true,
      data: { note: "nested wrapper" },
      marker: "finished before cancellation",
    };
    const traversal = new Traversal(
      [actionNode("completed", "Completed action"), actionNode("failed")],
      []
    );

    restoreCompletedNodeProgress(traversal, [
      {
        nodeId: "completed",
        nodeName: "Persisted action name",
        status: "success",
        output,
        error: null,
      },
      {
        nodeId: "failed",
        nodeName: "Failed action",
        status: "error",
        output: { message: "failure output is not addressable" },
        error: "action failed before cancellation",
      },
    ]);

    expect(traversal.results.completed).toEqual({
      success: true,
      data: { success: true, data: output },
    });
    expect(traversal.outputs.completed).toEqual({
      label: "Completed action",
      data: { success: true, data: output },
    });
    expect(
      resolveTemplateString(
        "{{@completed:Completed action.marker}}",
        traversal.outputs
      )
    ).toBe("finished before cancellation");
    expect(traversal.results.failed).toEqual({
      success: false,
      error: engineFailure("failure", "action failed before cancellation"),
    });
    expect(traversal.outputs.failed).toEqual({ label: "failed", data: null });
    expect(traversal.resultCount).toBe(2);
    expect(traversal.allSucceeded()).toBe(false);
  });

  it("preserves traversal results and outputs already written by the live run", () => {
    const lifecycleNode = actionNode("lifecycle", "Lifecycle");
    const traversal = new Traversal([lifecycleNode], []);
    const currentResult = {
      success: true as const,
      data: { event: "start" },
    };
    const cancelPayload = { event: "cancel" };

    traversal.markCompleted("lifecycle", currentResult, {
      label: "Lifecycle",
      data: currentResult.data,
    });
    traversal.setOutput("lifecycle", {
      label: "Lifecycle",
      data: cancelPayload,
    });

    restoreCompletedNodeProgress(traversal, [
      {
        nodeId: "lifecycle",
        nodeName: "Lifecycle",
        status: "error",
        output: null,
        error: "stale started-side log",
      },
    ]);

    expect(traversal.results.lifecycle).toEqual(currentResult);
    expect(traversal.outputs.lifecycle).toEqual({
      label: "Lifecycle",
      data: cancelPayload,
    });
  });

  it("keeps prototype-shaped ids and outputs from a node removed by migration", () => {
    const traversal = new Traversal([actionNode("__proto__")], []);

    restoreCompletedNodeProgress(traversal, [
      {
        nodeId: "__proto__",
        nodeName: "Prototype node",
        status: "success",
        output: { marker: "safe" },
        error: null,
      },
      {
        nodeId: "missing-node",
        nodeName: "Removed by migration",
        status: "error",
        output: null,
        error: "completed before migration",
      },
    ]);

    expect(Object.hasOwn(traversal.results, "__proto__")).toBe(true);
    expect(Object.hasOwn(traversal.outputs, "__proto__")).toBe(true);
    expect(traversal.results["__proto__"]).toEqual({
      success: true,
      data: { success: true, data: { marker: "safe" } },
    });
    expect(traversal.results["missing-node"]).toEqual({
      success: false,
      error: engineFailure("failure", "completed before migration"),
    });
    expect(traversal.outputs["missing-node"]).toEqual({
      label: "Removed by migration",
      data: null,
    });
    expect(traversal.resultCount).toBe(2);
  });
});
