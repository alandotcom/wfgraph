import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { isWorkflowOwnerAtom } from "#src/lib/workflow-save-store";
import {
  propertiesPanelActiveTabAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";

describe("selectedExecutionIdAtom", () => {
  it("reports a written id while the Runs tab is up and the viewer owns the workflow", () => {
    const store = createStore();
    store.set(isWorkflowOwnerAtom, true);
    store.set(propertiesPanelActiveTabAtom, "runs");
    store.set(selectedExecutionIdAtom, "exec_1");

    expect(store.get(selectedExecutionIdAtom)).toBe("exec_1");
  });

  it("reads null once the tab is Properties, keeping the write for later", () => {
    const store = createStore();
    store.set(isWorkflowOwnerAtom, true);
    store.set(propertiesPanelActiveTabAtom, "runs");
    store.set(selectedExecutionIdAtom, "exec_1");

    store.set(propertiesPanelActiveTabAtom, "properties");
    expect(store.get(selectedExecutionIdAtom)).toBeNull();

    store.set(propertiesPanelActiveTabAtom, "runs");
    expect(store.get(selectedExecutionIdAtom)).toBe("exec_1");
  });

  it("reads null for a non-owner whose stored tab is Runs", () => {
    const store = createStore();
    store.set(isWorkflowOwnerAtom, true);
    store.set(propertiesPanelActiveTabAtom, "runs");
    store.set(selectedExecutionIdAtom, "exec_1");

    store.set(isWorkflowOwnerAtom, false);
    expect(store.get(selectedExecutionIdAtom)).toBeNull();
  });
});
