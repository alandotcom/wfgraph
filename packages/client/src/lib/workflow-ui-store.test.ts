import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import {
  selectedExecutionIdAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";

describe("selectedExecutionIdAtom", () => {
  it("reports a written id while the Runs workspace is active", () => {
    const store = createStore();
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(selectedExecutionIdAtom, "exec_1");

    expect(store.get(selectedExecutionIdAtom)).toBe("exec_1");
  });

  it("reads null outside Runs while keeping the run selection for later", () => {
    const store = createStore();
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(selectedExecutionIdAtom, "exec_1");

    store.set(workflowWorkspaceViewAtom, "draft");
    expect(store.get(selectedExecutionIdAtom)).toBeNull();

    store.set(workflowWorkspaceViewAtom, "runs");
    expect(store.get(selectedExecutionIdAtom)).toBe("exec_1");
  });

  it("keeps the Runs workspace selection as UI state", () => {
    const store = createStore();
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(selectedExecutionIdAtom, "exec_1");

    expect(store.get(selectedExecutionIdAtom)).toBe("exec_1");
  });
});

describe("workflowWorkspaceViewAtom", () => {
  it("defaults to Draft", () => {
    const store = createStore();

    expect(store.get(workflowWorkspaceViewAtom)).toBe("draft");
  });

  it("keeps the selected workspace while the inspector resolves publication data", () => {
    const store = createStore();
    store.set(workflowWorkspaceViewAtom, "changes");

    expect(store.get(workflowWorkspaceViewAtom)).toBe("changes");
  });

  it("keeps a selected run available after visiting Changes", () => {
    const store = createStore();
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(selectedExecutionIdAtom, "exec_1");

    store.set(workflowWorkspaceViewAtom, "changes");
    expect(store.get(selectedExecutionIdAtom)).toBeNull();

    store.set(workflowWorkspaceViewAtom, "runs");
    expect(store.get(selectedExecutionIdAtom)).toBe("exec_1");
  });
});
