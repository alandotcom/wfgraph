import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  isAgentPanelExpandedAtom,
  isAgentPanelOpenAtom,
  selectedExecutionIdAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";

function workflowStore() {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "workflow_1");
  return store;
}

describe("selectedExecutionIdAtom", () => {
  it("reports the run the route names while Runs is active", () => {
    const store = workflowStore();
    showWorkspaceRoute(store, { view: "runs", executionId: "exec_1" });

    expect(store.get(selectedExecutionIdAtom)).toBe("exec_1");
  });

  it("reads null outside Runs and for the run list", () => {
    const store = workflowStore();
    showWorkspaceRoute(store, { view: "runs" });
    expect(store.get(selectedExecutionIdAtom)).toBeNull();

    showWorkspaceRoute(store, {});
    expect(store.get(selectedExecutionIdAtom)).toBeNull();
  });
});

describe("workflowWorkspaceViewAtom", () => {
  it("defaults to Draft", () => {
    const store = createStore();

    expect(store.get(workflowWorkspaceViewAtom)).toBe("draft");
  });

  it("reads the view the route names", () => {
    const store = workflowStore();
    showWorkspaceRoute(store, { view: "changes" });

    expect(store.get(workflowWorkspaceViewAtom)).toBe("changes");
  });
});

describe("isAgentPanelExpandedAtom", () => {
  it("is never true for a closed panel, and a reopened panel starts docked", () => {
    const store = createStore();
    store.set(isAgentPanelOpenAtom, false);
    store.set(isAgentPanelExpandedAtom, true);
    expect(store.get(isAgentPanelExpandedAtom)).toBe(false);

    store.set(isAgentPanelOpenAtom, true);
    store.set(isAgentPanelExpandedAtom, true);
    expect(store.get(isAgentPanelExpandedAtom)).toBe(true);

    store.set(isAgentPanelOpenAtom, false);
    store.set(isAgentPanelOpenAtom, true);
    expect(store.get(isAgentPanelExpandedAtom)).toBe(false);
  });
});
