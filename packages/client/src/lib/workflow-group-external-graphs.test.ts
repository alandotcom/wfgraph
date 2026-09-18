import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  applyAgentGraphAtom,
  installRemoteWorkflowAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import {
  hasUnsavedChangesAtom,
  lastSaveErrorAtom,
  saveWorkflowAtom,
} from "#src/lib/workflow-save-store";
import { activeAgentTurnIdAtom } from "#src/lib/workflow-ui-store";
import { type WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  updateMock,
  lifecycle,
  lookup,
  edge,
  ungroupedGraph,
  createGraphStore,
  tick,
  graphOf,
  expectWholeGroups,
  expectEverySaveWhole,
  type Store,
  type Graph,
} from "./workflow-group-mutations-test-support";
import { savedWorkflow } from "./workflow-save-test-support";

beforeEach(() => {
  vi.clearAllMocks();
});

const turnId = Symbol("agent-turn");

describe("Group rules for graphs from outside the canvas", () => {
  function agentStore(): Store {
    const store = createGraphStore(ungroupedGraph());
    store.set(activeAgentTurnIdAtom, turnId);
    return store;
  }

  function frame(): WorkflowNode {
    return {
      id: "g",
      type: "group",
      position: { x: 0, y: 150 },
      width: 400,
      height: 300,
      data: { label: "Group", type: "group" },
    };
  }

  function member(node: WorkflowNode, parentId = "g"): WorkflowNode {
    return { ...node, parentId, extent: "parent", draggable: false };
  }

  it("ungroups a Group an agent edit left with one member before saving", async () => {
    const store = agentStore();

    expect(
      store.set(applyAgentGraphAtom, {
        workflowId: "workflow_1",
        turnId,
        recordHistory: true,
        nodes: [lifecycle(), frame(), member(lookup("a")), lookup("after")],
        edges: [
          edge("start-a", "life", "a", "started"),
          edge("a-after", "a", "after"),
        ],
        catalog: emptyExtensionCatalog,
      })
    ).toBe(true);
    await tick();

    const nodes = store.get(nodesAtom);
    expect(nodes.map((node) => node.id).sort()).toEqual(["a", "after", "life"]);
    expect(nodes.find((node) => node.id === "a")).not.toHaveProperty(
      "parentId"
    );
    expectEverySaveWhole();
  });

  it("refuses an agent graph whose member names a missing frame", async () => {
    const store = agentStore();
    const before = graphOf(store);

    expect(
      store.set(applyAgentGraphAtom, {
        workflowId: "workflow_1",
        turnId,
        recordHistory: true,
        nodes: [
          lifecycle(),
          member(lookup("a"), "gone"),
          member(lookup("b"), "gone"),
        ],
        edges: [],
        catalog: emptyExtensionCatalog,
      })
    ).toBe(false);
    await tick();

    expect(graphOf(store)).toEqual(before);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("ungroups an undersized Group in a draft revision installed from the server", () => {
    const store = createGraphStore(ungroupedGraph());

    const installed = store.set(installRemoteWorkflowAtom, {
      ...savedWorkflow("workflow_1", {
        nodes: [lifecycle(), frame(), member(lookup("a"))],
        edges: [edge("start-a", "life", "a", "started")],
      }),
      draftRevision: 2,
    });

    expect(installed).toBe(true);
    const nodes = store.get(nodesAtom);
    expect(nodes.map((node) => node.id)).toEqual(["life", "a"]);
    expectWholeGroups(graphOf(store));
    // The install sends nothing itself. The repaired graph differs from the
    // stored draft, so it is left unsaved for the next save to write.
    expect(updateMock).not.toHaveBeenCalled();
    expect(store.get(hasUnsavedChangesAtom)).toBe(true);
  });

  it("marks a loaded graph unsaved only when loading dissolved a Group", () => {
    const repaired = createGraphStore({
      nodes: [lifecycle(), frame(), member(lookup("a"))],
      edges: [edge("start-a", "life", "a", "started")],
    });
    expect(repaired.get(nodesAtom).map((node) => node.id)).toEqual([
      "life",
      "a",
    ]);
    expect(repaired.get(hasUnsavedChangesAtom)).toBe(true);

    const whole = createGraphStore({
      nodes: [lifecycle(), frame(), member(lookup("a")), member(lookup("b"))],
      edges: [edge("start-a", "life", "a", "started")],
    });
    expect(whole.get(nodesAtom).map((node) => node.id)).toEqual([
      "life",
      "g",
      "a",
      "b",
    ]);
    expect(whole.get(hasUnsavedChangesAtom)).toBe(false);
  });

  /** A Group whose stored edge names the frame, which a draft save refuses. */
  function edgeOntoFrameGraph(): Graph {
    return {
      nodes: [lifecycle(), frame(), member(lookup("a")), member(lookup("b"))],
      edges: [edge("start-g", "life", "g", "started")],
    };
  }

  it("saves a Group that breaks only the Publish rules", async () => {
    const store = createGraphStore(ungroupedGraph());

    const outcome = await store.set(
      saveWorkflowAtom,
      { nodes: [lifecycle(), frame(), member(lookup("a"))], edges: [] },
      { immediate: true }
    );

    expect(outcome?.ok).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to save a Group structure the server's draft save refuses", async () => {
    const store = createGraphStore(ungroupedGraph());

    const outcome = await store.set(saveWorkflowAtom, edgeOntoFrameGraph(), {
      immediate: true,
    });

    expect(outcome?.ok).toBe(false);
    expect(store.get(lastSaveErrorAtom)?.message).toBe(
      outcome?.ok === false ? outcome.error.message : undefined
    );
    expect(store.get(hasUnsavedChangesAtom)).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("keeps a refused graph unsaved when an older queued save lands", async () => {
    const store = createGraphStore(ungroupedGraph());

    // A debounced save of a valid graph is still queued when the next graph
    // is refused, and that older save then succeeds.
    const queued = store.set(saveWorkflowAtom, ungroupedGraph());
    const refused = await store.set(saveWorkflowAtom, edgeOntoFrameGraph());
    expect(refused?.ok).toBe(false);
    expect((await queued)?.ok).toBe(true);

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(store.get(hasUnsavedChangesAtom)).toBe(true);
    expect(store.get(lastSaveErrorAtom)).toBe(
      refused?.ok === false ? refused.error : undefined
    );

    // An accepted graph queued after the refusal is what clears it.
    const accepted = await store.set(saveWorkflowAtom, ungroupedGraph(), {
      immediate: true,
    });
    expect(accepted?.ok).toBe(true);
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(store.get(lastSaveErrorAtom)).toBeNull();
  });
});
