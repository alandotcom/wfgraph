import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { toSerializedGraph } from "#src/lib/rpc-client";
import { historyAtom } from "#src/lib/workflow-graph-cells";
import {
  clearSelectionAtom,
  displayEdgesAtom,
  displayNodesAtom,
  edgesAtom,
  executionOverlayGraphAtom,
  hydrateWorkflowAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  onEdgesChangeAtom,
  onNodesChangeAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { workspaceAddressFromSearch } from "#src/lib/workflow-navigation-state";
import {
  currentWorkflowIdAtom,
  hasUnsavedChangesAtom,
} from "#src/lib/workflow-save-store";
import {
  selectedExecutionIdAtom,
  workflowGraphUpdateAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import {
  activeDesktopRevealLevelAtom,
  activeRevealPresentationAtom,
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  chooseDesktopRevealLevelAtom,
  recordInspectorScrollAtom,
  openInspectorSectionAtom,
  recordInspectorSectionAtom,
  setWorkspaceRevealLevelAtom,
  activeWorkspaceCamerasAtom,
  forgetWorkflowNavigationAtom,
  recordWorkspaceCameraAtom,
  rememberedRouteSearchesAtom,
  setWorkspaceSelectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";

function actionNode(id: string, parentId?: string): WorkflowNode {
  return omitUndefined({
    id,
    type: "action",
    position: { x: id.length * 40, y: 120 },
    parentId,
    data: { label: id, type: "action" as const },
  });
}

function draftStore() {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(loadWorkflowGraphAtom, {
    nodes: [
      actionNode("draft_step"),
      {
        id: "group_1",
        type: "group",
        position: { x: 0, y: 0 },
        data: { label: "group_1", type: "group" },
      },
      actionNode("child_step", "group_1"),
      actionNode("other_child_step", "group_1"),
    ],
    edges: [{ id: "edge_1", source: "draft_step", target: "child_step" }],
  });
  showWorkspaceRoute(store, {});
  return store;
}

describe("active workspace address", () => {
  it("is the address the route names for the open workflow", () => {
    const store = draftStore();
    showWorkspaceRoute(store, { view: "runs", executionId: "run_1" });

    expect(store.get(activeWorkspaceAddressAtom)).toEqual({
      workflowId: "workflow_1",
      key: { workspace: "runs", executionId: "run_1" },
      scope: { kind: "overview" },
    });
    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");
    expect(store.get(selectedExecutionIdAtom)).toBe("run_1");

    showWorkspaceRoute(store, { view: "changes", compare: "version_1" });
    expect(store.get(workflowWorkspaceViewAtom)).toBe("changes");
    expect(store.get(selectedExecutionIdAtom)).toBeNull();
  });

  it("shows the open workflow's Draft until the route names that workflow", () => {
    const store = draftStore();
    showWorkspaceRoute(store, { view: "runs", executionId: "run_1" });

    store.set(currentWorkflowIdAtom, "workflow_2");

    expect(store.get(activeWorkspaceAddressAtom)).toEqual({
      workflowId: "workflow_2",
      key: { workspace: "draft" },
      scope: { kind: "overview" },
    });
    expect(store.get(selectedExecutionIdAtom)).toBeNull();
  });

  it("remembers the search each view last showed", () => {
    const store = draftStore();
    showWorkspaceRoute(store, { view: "runs", executionId: "run_1" });
    showWorkspaceRoute(store, { view: "changes", compare: "version_1" });
    showWorkspaceRoute(store, { group: "group_1" });

    expect(store.get(rememberedRouteSearchesAtom)).toEqual({
      draft: { group: "group_1" },
      runs: { view: "runs", executionId: "run_1" },
      changes: { view: "changes", compare: "version_1" },
    });
  });
});

/** The node ids and edge ids the active canvas paints as selected. */
function paintedSelection(store: ReturnType<typeof createStore>) {
  return {
    nodeIds: store
      .get(displayNodesAtom)
      .filter((node) => node.selected)
      .map((node) => node.id),
    edgeIds: store
      .get(displayEdgesAtom)
      .filter((edge) => edge.selected)
      .map((edge) => edge.id),
  };
}

describe("selection", () => {
  it("belongs to one address and comes back with it", () => {
    const store = draftStore();
    store.set(selectOnlyNodeAtom, "draft_step");

    showWorkspaceRoute(store, { view: "runs", executionId: "run_1" });
    expect(store.get(selectedNodeAtom)).toBeNull();
    store.set(selectOnlyNodeAtom, "run_step");

    showWorkspaceRoute(store, { view: "runs", executionId: "run_2" });
    expect(store.get(selectedNodeAtom)).toBeNull();

    showWorkspaceRoute(store, { view: "changes", compare: "version_1" });
    store.set(activeSelectionAtom, {
      nodeIds: [],
      edgeIds: ["comparison_edge"],
    });

    showWorkspaceRoute(store, {});
    expect(store.get(selectedNodeAtom)).toBe("draft_step");
    expect(paintedSelection(store)).toEqual({
      nodeIds: ["draft_step"],
      edgeIds: [],
    });

    showWorkspaceRoute(store, { view: "runs", executionId: "run_1" });
    expect(store.get(selectedNodeAtom)).toBe("run_step");

    showWorkspaceRoute(store, { view: "changes", compare: "version_1" });
    expect(store.get(selectedEdgeAtom)).toBe("comparison_edge");
    expect(store.get(selectedNodeAtom)).toBeNull();
  });

  it("paints a focused Group scope's selection apart from the overview's", () => {
    const store = draftStore();
    store.set(selectOnlyNodeAtom, "draft_step");

    showWorkspaceRoute(store, { group: "group_1" });
    expect(store.get(selectedNodeAtom)).toBeNull();
    expect(paintedSelection(store)).toEqual({ nodeIds: [], edgeIds: [] });
    store.set(selectOnlyNodeAtom, "child_step");

    showWorkspaceRoute(store, {});
    expect(store.get(selectedNodeAtom)).toBe("draft_step");
    expect(paintedSelection(store).nodeIds).toEqual(["draft_step"]);
    showWorkspaceRoute(store, { group: "group_1" });
    expect(store.get(selectedNodeAtom)).toBe("child_step");
    expect(paintedSelection(store).nodeIds).toEqual(["child_step"]);
  });

  it("keeps a Draft multi-selection from React Flow changes in the address", () => {
    const store = draftStore();
    store.set(onNodesChangeAtom, [
      { type: "select", id: "draft_step", selected: true },
    ]);
    store.set(onNodesChangeAtom, [
      { type: "select", id: "child_step", selected: true },
    ]);
    store.set(onEdgesChangeAtom, [
      { type: "select", id: "edge_1", selected: true },
    ]);

    expect(store.get(activeSelectionAtom)).toEqual({
      nodeIds: ["draft_step", "child_step"],
      edgeIds: ["edge_1"],
    });
    expect(store.get(selectedNodeAtom)).toBeNull();
    expect(paintedSelection(store)).toEqual({
      nodeIds: ["draft_step", "child_step"],
      edgeIds: ["edge_1"],
    });
    expect(store.get(nodesAtom).some((node) => "selected" in node)).toBe(false);
    expect(store.get(edgesAtom).some((edge) => "selected" in edge)).toBe(false);

    showWorkspaceRoute(store, { view: "runs" });
    showWorkspaceRoute(store, {});
    expect(paintedSelection(store).nodeIds).toEqual([
      "draft_step",
      "child_step",
    ]);

    store.set(clearSelectionAtom);
    expect(paintedSelection(store)).toEqual({ nodeIds: [], edgeIds: [] });
  });

  it("clears Draft and comparison selections on a Draft load and keeps a run's", () => {
    const store = draftStore();
    store.set(selectOnlyNodeAtom, "draft_step");
    showWorkspaceRoute(store, { view: "changes", compare: "version_1" });
    store.set(selectOnlyNodeAtom, "comparison_step");
    showWorkspaceRoute(store, { view: "runs", executionId: "run_1" });
    store.set(executionOverlayGraphAtom, {
      nodes: [actionNode("run_step")],
      edges: [],
    });
    store.set(selectOnlyNodeAtom, "run_step");

    store.set(loadWorkflowGraphAtom, {
      nodes: [actionNode("draft_step")],
      edges: [],
    });

    expect(store.get(activeSelectionAtom)).toEqual({
      nodeIds: ["run_step"],
      edgeIds: [],
    });
    showWorkspaceRoute(store, { view: "changes", compare: "version_1" });
    expect(store.get(selectedNodeAtom)).toBeNull();
    showWorkspaceRoute(store, {});
    expect(store.get(selectedNodeAtom)).toBeNull();
    expect(paintedSelection(store)).toEqual({ nodeIds: [], edgeIds: [] });
  });

  it("opening another workflow clears that workflow's selection only", () => {
    const store = draftStore();
    store.set(selectOnlyNodeAtom, "draft_step");
    store.set(setWorkspaceSelectionAtom, {
      address: workspaceAddressFromSearch("workflow_2", {}),
      selection: { nodeIds: ["other_step"], edgeIds: [] },
    });

    store.set(
      hydrateWorkflowAtom,
      savedWorkflow("workflow_2", {
        nodes: [actionNode("other_step")],
        edges: [],
      })
    );
    expect(store.get(selectedNodeAtom)).toBeNull();

    store.set(currentWorkflowIdAtom, "workflow_1");
    expect(store.get(selectedNodeAtom)).toBe("draft_step");
  });

  it("selects a Draft step from Runs without touching the run's selection", () => {
    const store = draftStore();
    store.set(selectOnlyNodeAtom, "child_step");
    showWorkspaceRoute(store, { view: "runs", executionId: "run_1" });
    store.set(selectOnlyNodeAtom, "run_step");

    store.set(setWorkspaceSelectionAtom, {
      address: workspaceAddressFromSearch("workflow_1", {}),
      selection: { nodeIds: ["draft_step"], edgeIds: [] },
    });
    expect(store.get(selectedNodeAtom)).toBe("run_step");

    showWorkspaceRoute(store, {});
    expect(store.get(selectedNodeAtom)).toBe("draft_step");
    expect(paintedSelection(store).nodeIds).toEqual(["draft_step"]);
  });
});

describe("desktop Reveal level", () => {
  it("starts a Runs or Changes scope first shown from another view at the preference", () => {
    const store = draftStore();
    showWorkspaceRoute(store, { view: "runs" });
    store.set(chooseDesktopRevealLevelAtom, "closed");

    showWorkspaceRoute(store, { view: "changes" });
    expect(store.get(activeDesktopRevealLevelAtom)).toBe("closed");
    store.set(chooseDesktopRevealLevelAtom, "browse");

    showWorkspaceRoute(store, { view: "runs" });
    expect(store.get(activeDesktopRevealLevelAtom)).toBe("closed");
    showWorkspaceRoute(store, { view: "changes" });
    expect(store.get(activeDesktopRevealLevelAtom)).toBe("browse");
  });

  it("starts a Draft scope closed whatever the preference is", () => {
    const store = draftStore();
    showWorkspaceRoute(store, { view: "runs" });
    store.set(chooseDesktopRevealLevelAtom, "browse");

    showWorkspaceRoute(store, { group: "group_1" });
    expect(store.get(activeDesktopRevealLevelAtom)).toBe("closed");
  });

  it("opens Draft Reveal at the reopen level when a step becomes the selection", () => {
    const store = draftStore();
    store.set(selectOnlyNodeAtom, "draft_step");
    expect(store.get(activeDesktopRevealLevelAtom)).toBe("browse");

    store.set(setWorkspaceRevealLevelAtom, {
      address: store.get(activeWorkspaceAddressAtom),
      level: "focus",
    });
    store.set(setWorkspaceRevealLevelAtom, {
      address: store.get(activeWorkspaceAddressAtom),
      level: "closed",
    });
    store.set(clearSelectionAtom);
    store.set(selectOnlyNodeAtom, "child_step");

    expect(store.get(activeDesktopRevealLevelAtom)).toBe("focus");
    expect(store.get(activeRevealPresentationAtom).inspected).toEqual({
      kind: "node",
      id: "child_step",
    });
  });

  it("keeps each scope's Focus level, inspected step, and scroll apart", () => {
    const store = draftStore();
    store.set(selectOnlyNodeAtom, "draft_step");
    const draft = store.get(activeWorkspaceAddressAtom);
    store.set(setWorkspaceRevealLevelAtom, { address: draft, level: "focus" });
    store.set(recordInspectorScrollAtom, {
      address: draft,
      inspectedId: "draft_step",
      level: "focus",
      top: 240,
    });

    showWorkspaceRoute(store, { group: "group_1" });
    store.set(selectOnlyNodeAtom, "child_step");
    expect(store.get(activeDesktopRevealLevelAtom)).toBe("browse");
    expect(store.get(activeRevealPresentationAtom).inspectorScroll).toEqual({
      browse: 0,
      focus: 0,
    });

    showWorkspaceRoute(store, { view: "runs", executionId: "run_1" });
    showWorkspaceRoute(store, {});
    expect(store.get(activeDesktopRevealLevelAtom)).toBe("focus");
    expect(store.get(activeRevealPresentationAtom)).toMatchObject({
      inspected: { kind: "node", id: "draft_step" },
      inspectorScroll: { browse: 0, focus: 240 },
    });
  });

  it("keeps each scope's inspector section apart and drops one for another object", () => {
    const store = draftStore();
    store.set(selectOnlyNodeAtom, "draft_step");
    const draft = store.get(activeWorkspaceAddressAtom);
    store.set(recordInspectorSectionAtom, {
      address: draft,
      inspectedId: "draft_step",
      section: "validation",
    });
    store.set(recordInspectorSectionAtom, {
      address: draft,
      inspectedId: "child_step",
      section: "connections",
    });
    expect(store.get(activeRevealPresentationAtom).inspectorSection).toBe(
      "validation"
    );

    showWorkspaceRoute(store, { group: "group_1" });
    store.set(selectOnlyNodeAtom, "child_step");
    expect(store.get(activeRevealPresentationAtom).inspectorSection).toBeNull();

    showWorkspaceRoute(store, {});
    expect(store.get(activeRevealPresentationAtom).inspectorSection).toBe(
      "validation"
    );
  });

  it("opens another object's section at Focus in one write", () => {
    const store = draftStore();
    store.set(selectOnlyNodeAtom, "draft_step");
    const draft = store.get(activeWorkspaceAddressAtom);
    store.set(setWorkspaceRevealLevelAtom, { address: draft, level: "closed" });

    store.set(openInspectorSectionAtom, {
      address: draft,
      nodeId: "child_step",
      section: "connections",
    });

    expect(store.get(activeSelectionAtom)).toEqual({
      nodeIds: ["child_step"],
      edgeIds: [],
    });
    expect(store.get(activeRevealPresentationAtom)).toMatchObject({
      revealLevel: "focus",
      inspected: { kind: "node", id: "child_step" },
      inspectorSection: "connections",
    });
  });

  it("drops a scroll read for a step the scope no longer inspects", () => {
    const store = draftStore();
    store.set(selectOnlyNodeAtom, "draft_step");
    store.set(selectOnlyNodeAtom, "child_step");

    store.set(recordInspectorScrollAtom, {
      address: store.get(activeWorkspaceAddressAtom),
      inspectedId: "draft_step",
      level: "browse",
      top: 300,
    });

    expect(store.get(activeRevealPresentationAtom).inspectorScroll.browse).toBe(
      0
    );
  });

  it("keeps the level a scope showed when another workspace is toggled", () => {
    const store = draftStore();
    showWorkspaceRoute(store, { view: "changes" });
    const changesLevel = store.get(activeDesktopRevealLevelAtom);

    showWorkspaceRoute(store, { view: "runs" });
    store.set(
      chooseDesktopRevealLevelAtom,
      changesLevel === "closed" ? "browse" : "closed"
    );
    showWorkspaceRoute(store, { view: "changes" });

    expect(store.get(activeDesktopRevealLevelAtom)).toBe(changesLevel);
  });

  it("never writes the cookie when a workspace is restored", () => {
    const store = draftStore();
    showWorkspaceRoute(store, { view: "runs" });
    store.set(chooseDesktopRevealLevelAtom, "closed");
    showWorkspaceRoute(store, { view: "changes" });
    store.set(chooseDesktopRevealLevelAtom, "browse");
    store.set(selectOnlyNodeAtom, "draft_step");
    const cookie = document.cookie;

    showWorkspaceRoute(store, {});
    store.set(selectOnlyNodeAtom, "draft_step");
    showWorkspaceRoute(store, { view: "runs" });
    showWorkspaceRoute(store, {});

    expect(document.cookie).toBe(cookie);
  });
});

describe("cameras", () => {
  it("keeps desktop and mobile cameras apart for the same scope", () => {
    const store = draftStore();
    const address = store.get(activeWorkspaceAddressAtom);
    store.set(recordWorkspaceCameraAtom, {
      address,
      formFactor: "desktop",
      camera: { centerX: 100, centerY: 50, zoom: 0.8 },
    });
    store.set(recordWorkspaceCameraAtom, {
      address,
      formFactor: "mobile",
      camera: { centerX: 12, centerY: 400, zoom: 1.4 },
    });

    expect(store.get(activeWorkspaceCamerasAtom)).toEqual({
      desktop: { centerX: 100, centerY: 50, zoom: 0.8 },
      mobile: { centerX: 12, centerY: 400, zoom: 1.4 },
    });
    showWorkspaceRoute(store, { group: "group_1" });
    expect(store.get(activeWorkspaceCamerasAtom)).toEqual({
      desktop: null,
      mobile: null,
    });
  });
});

describe("forgetWorkflowNavigationAtom", () => {
  it("drops what a deleted workflow remembered", () => {
    const store = draftStore();
    showWorkspaceRoute(store, { view: "runs", executionId: "run_1" });
    store.set(selectOnlyNodeAtom, "run_step");

    store.set(forgetWorkflowNavigationAtom, "workflow_1");

    expect(store.get(selectedNodeAtom)).toBeNull();
    expect(store.get(rememberedRouteSearchesAtom)).toEqual({});
  });
});

describe("navigation and the workflow definition", () => {
  it("never lays out, moves, saves, or records history while navigating", () => {
    const store = draftStore();
    const nodesBefore = store.get(nodesAtom);
    const persistedBefore = toSerializedGraph({
      nodes: nodesBefore,
      edges: store.get(edgesAtom),
    });
    const graphUpdateBefore = store.get(workflowGraphUpdateAtom);

    store.set(selectOnlyNodeAtom, "draft_step");
    showWorkspaceRoute(store, { group: "group_1" });
    store.set(recordWorkspaceCameraAtom, {
      address: store.get(activeWorkspaceAddressAtom),
      formFactor: "desktop",
      camera: { centerX: 1, centerY: 2, zoom: 3 },
    });
    store.set(setWorkspaceRevealLevelAtom, {
      address: store.get(activeWorkspaceAddressAtom),
      level: "focus",
    });
    showWorkspaceRoute(store, { view: "runs", executionId: "run_1" });
    showWorkspaceRoute(store, { view: "changes", compare: "version_1" });
    store.set(setWorkspaceSelectionAtom, {
      address: workspaceAddressFromSearch("workflow_1", {}),
      selection: { nodeIds: ["child_step"], edgeIds: [] },
    });
    showWorkspaceRoute(store, {});

    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(store.get(historyAtom)).toEqual([]);
    expect(store.get(workflowGraphUpdateAtom)).toBe(graphUpdateBefore);
    expect(
      store.get(nodesAtom).map((node) => [node.id, node.position])
    ).toEqual(nodesBefore.map((node) => [node.id, node.position]));
    expect(
      toSerializedGraph({
        nodes: store.get(nodesAtom),
        edges: store.get(edgesAtom),
      })
    ).toEqual(persistedBefore);
  });
});
