import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { isWorkflowOwnerAtom } from "#src/lib/workflow-save-store";
import {
  selectedExecutionIdAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";

describe("selectedExecutionIdAtom", () => {
  it("reports a written id while the Runs workspace is active", () => {
    const store = createStore();
    store.set(isWorkflowOwnerAtom, true);
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(selectedExecutionIdAtom, "exec_1");

    expect(store.get(selectedExecutionIdAtom)).toBe("exec_1");
  });

  it("reads null outside Runs while keeping the run selection for later", () => {
    const store = createStore();
    store.set(isWorkflowOwnerAtom, true);
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(selectedExecutionIdAtom, "exec_1");

    store.set(workflowWorkspaceViewAtom, "draft");
    expect(store.get(selectedExecutionIdAtom)).toBeNull();

    store.set(workflowWorkspaceViewAtom, "runs");
    expect(store.get(selectedExecutionIdAtom)).toBe("exec_1");
  });

  it("reads null for a non-owner whose stored tab is Runs", () => {
    const store = createStore();
    store.set(isWorkflowOwnerAtom, true);
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(selectedExecutionIdAtom, "exec_1");

    store.set(isWorkflowOwnerAtom, false);
    expect(store.get(selectedExecutionIdAtom)).toBeNull();
  });
});

describe("workflowWorkspaceViewAtom", () => {
  it("defaults to Draft", () => {
    const store = createStore();

    expect(store.get(workflowWorkspaceViewAtom)).toBe("draft");
  });

  it("allows Changes for an owner while the inspector resolves publication data", () => {
    const store = createStore();
    store.set(isWorkflowOwnerAtom, true);
    store.set(workflowWorkspaceViewAtom, "changes");

    expect(store.get(workflowWorkspaceViewAtom)).toBe("changes");

    store.set(isWorkflowOwnerAtom, false);
    expect(store.get(workflowWorkspaceViewAtom)).toBe("draft");
  });

  it("keeps a selected run available after visiting Changes", () => {
    const store = createStore();
    store.set(isWorkflowOwnerAtom, true);
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(selectedExecutionIdAtom, "exec_1");

    store.set(workflowWorkspaceViewAtom, "changes");
    expect(store.get(selectedExecutionIdAtom)).toBeNull();

    store.set(workflowWorkspaceViewAtom, "runs");
    expect(store.get(selectedExecutionIdAtom)).toBe("exec_1");
  });
});
