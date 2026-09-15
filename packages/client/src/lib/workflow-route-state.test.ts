import { describe, expect, it } from "vitest";
import { ApiError } from "#src/lib/rpc-client";
import {
  classifyWorkflowLoadFailure,
  authorizedWorkflowSearch,
  publishWorkflowAfterCompletedSaves,
  WORKFLOW_LOAD_ERROR_MESSAGE,
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

  it("keeps a run only in Runs and a comparison base only in Changes", () => {
    const access = { canOpenRuns: true, canOpenComparison: true };
    expect(
      authorizedWorkflowSearch(
        { view: "runs", executionId: "exec_1", compare: "version_1" },
        access
      )
    ).toEqual({ view: "runs", executionId: "exec_1" });
    expect(
      authorizedWorkflowSearch(
        { view: "changes", executionId: "exec_1", compare: "version_1" },
        access
      )
    ).toEqual({ view: "changes", compare: "version_1" });
    // Draft is the absent view, so a run or base without its view is dropped.
    expect(
      authorizedWorkflowSearch(
        { executionId: "exec_1", compare: "version_1", group: "group_1" },
        access
      )
    ).toEqual({ group: "group_1" });
  });

  it("drops values that are not non-empty strings", () => {
    expect(
      authorizedWorkflowSearch(
        { view: "runs", executionId: "", group: ["group_1"] },
        { canOpenRuns: true, canOpenComparison: true }
      )
    ).toEqual({ view: "runs" });
    expect(
      authorizedWorkflowSearch(
        { view: "elsewhere", compare: 3 },
        { canOpenRuns: true, canOpenComparison: true }
      )
    ).toEqual({});
  });

  it("returns a view the viewer cannot open to Draft", () => {
    expect(
      authorizedWorkflowSearch(
        { view: "runs", executionId: "exec_1", group: "group_1" },
        { canOpenRuns: false, canOpenComparison: true }
      )
    ).toEqual({ group: "group_1" });
    expect(
      authorizedWorkflowSearch(
        { view: "changes", compare: "version_1" },
        { canOpenRuns: true, canOpenComparison: false }
      )
    ).toEqual({});
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
