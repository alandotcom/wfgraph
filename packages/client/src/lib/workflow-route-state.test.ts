import { describe, expect, it } from "vitest";
import { ApiError } from "#src/lib/rpc-client";
import {
  classifyWorkflowLoadFailure,
  WORKFLOW_LOAD_ERROR_MESSAGE,
  workflowPanelTab,
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
    expect(workflowPanelTab("exec_1")).toBe("runs");
    expect(workflowPanelTab(undefined)).toBe("properties");
  });
});
