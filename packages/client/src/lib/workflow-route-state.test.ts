import { describe, expect, it } from "vitest";
import { ApiError } from "#src/lib/rpc-client";
import {
  classifyWorkflowLoadFailure,
  executionIdFromWorkflowSearch,
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
});
