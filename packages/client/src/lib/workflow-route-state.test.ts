import { describe, expect, it } from "vitest";
import { ApiError } from "#src/lib/rpc-client";
import {
  classifyWorkflowLoadFailure,
  authorizedWorkflowSearch,
  executionIdFromWorkflowSearch,
  publishWorkflowAfterCompletedSaves,
  WORKFLOW_LOAD_ERROR_MESSAGE,
  workflowWorkspaceView,
} from "#src/lib/workflow-route-state";

describe("workflow route state", () => {
  it("shows not found only for a missing workflow", () => {
    expect(classifyWorkflowLoadFailure(new ApiError(404, "missing"))).toEqual({
      notFound: true,
      message: null,
    });
    expect(classifyWorkflowLoadFailure(new ApiError(500, "failed"))).toEqual({
      notFound: false,
      message: WORKFLOW_LOAD_ERROR_MESSAGE,
    });
    expect(classifyWorkflowLoadFailure(new Error("offline"))).toEqual({
      notFound: false,
      message: WORKFLOW_LOAD_ERROR_MESSAGE,
    });
  });

  it("opens runs only while a run is named in the URL", () => {
    expect(workflowWorkspaceView("exec_1")).toBe("runs");
    // Null rather than "properties": closing a run must leave the panel's own
    // tab alone, so the Back button lands on the runs list it names.
    expect(workflowWorkspaceView(undefined)).toBeNull();
  });

  it("reads only a non-empty string execution id from search", () => {
    expect(executionIdFromWorkflowSearch({ executionId: "exec_1" })).toBe(
      "exec_1"
    );
    expect(executionIdFromWorkflowSearch({ executionId: "" })).toBeUndefined();
    expect(executionIdFromWorkflowSearch({ executionId: 1 })).toBeUndefined();
    expect(executionIdFromWorkflowSearch(null)).toBeUndefined();
  });

  it("removes a latent run selection when run detail access is denied", () => {
    expect(authorizedWorkflowSearch({ executionId: "exec_1" }, false)).toEqual(
      {}
    );
    expect(authorizedWorkflowSearch({ executionId: "exec_1" }, true)).toEqual({
      executionId: "exec_1",
    });
  });

  it("refetches until no save completes during a workflow load", async () => {
    let saveGeneration = 1;
    const fetchedWorkflows = ["saved_once", "saved_twice"];
    const publishedWorkflows: Array<{
      workflow: string;
      saveGeneration: number;
    }> = [];
    const fetchWorkflow = async () => {
      const workflow = fetchedWorkflows.shift();
      if (!workflow) {
        throw new Error("Unexpected workflow fetch");
      }
      if (workflow === "saved_once") {
        saveGeneration = 2;
      }
      return workflow;
    };

    const result = await publishWorkflowAfterCompletedSaves({
      workflow: "before_save",
      saveGeneration: 0,
      getSaveGeneration: () => saveGeneration,
      fetchWorkflow,
      publishWorkflow: (snapshot) => publishedWorkflows.push(snapshot),
      signal: new AbortController().signal,
    });

    expect(result).toBe(true);
    expect(publishedWorkflows).toEqual([
      { workflow: "saved_twice", saveGeneration: 2 },
    ]);
    expect(fetchedWorkflows).toEqual([]);
  });

  it("does not publish a replacement workflow after route cancellation", async () => {
    const abortController = new AbortController();
    const publishedWorkflows: string[] = [];

    const result = await publishWorkflowAfterCompletedSaves({
      workflow: "before_save",
      saveGeneration: 0,
      getSaveGeneration: () => 1,
      fetchWorkflow: async () => {
        abortController.abort();
        return "after_save";
      },
      publishWorkflow: ({ workflow }) => publishedWorkflows.push(workflow),
      signal: abortController.signal,
    });

    expect(result).toBe(false);
    expect(publishedWorkflows).toEqual([]);
  });
});
