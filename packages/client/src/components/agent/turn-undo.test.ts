import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  agentTurnUndoStateAtom,
  recordAgentTurnUndoPointAtom,
  undoAgentTurnAtom,
} from "#src/components/agent/turn-undo";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  addNodeAtom,
  applyAgentGraphAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import {
  savedWorkflow,
  unreadableDraft,
} from "#src/lib/workflow-save-test-support";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import { activeAgentTurnIdAtom } from "#src/lib/workflow-ui-store";

const turnId = Symbol("agent-turn");

function actionNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action", config: { actionType: "noop" } },
  };
}

/** A store holding node `a`, after one agent turn that added node `b`. */
function storeAfterAgentTurn() {
  const store = createStore();
  store.set(workflowApiAtom, {
    update: vi.fn(() => Promise.resolve(savedWorkflow("workflow_1"))) as never,
    read: unreadableDraft,
  });
  store.set(autosaveDelayAtom, 0);
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(activeAgentTurnIdAtom, turnId);
  store.set(loadWorkflowGraphAtom, { nodes: [actionNode("a")], edges: [] });
  store.set(applyAgentGraphAtom, {
    workflowId: "workflow_1",
    turnId,
    recordHistory: true,
    nodes: [actionNode("a"), actionNode("b")],
    edges: [],
    catalog: emptyExtensionCatalog,
  });
  store.set(recordAgentTurnUndoPointAtom, "turn_1");
  store.set(activeAgentTurnIdAtom, null);
  return store;
}

const nodeIds = (store: ReturnType<typeof createStore>) =>
  store.get(nodesAtom).map((node) => node.id);

describe("agent turn undo", () => {
  it("reverts the whole turn and then says it was undone", () => {
    const store = storeAfterAgentTurn();
    expect(store.get(agentTurnUndoStateAtom("turn_1"))).toBe("available");

    store.set(undoAgentTurnAtom, "turn_1");

    expect(nodeIds(store)).toEqual(["a"]);
    expect(store.get(agentTurnUndoStateAtom("turn_1"))).toBe("undone");
  });

  it("is withdrawn once another edit lands on top of the turn", () => {
    const store = storeAfterAgentTurn();

    store.set(addNodeAtom, actionNode("c"));
    store.set(undoAgentTurnAtom, "turn_1");

    expect(store.get(agentTurnUndoStateAtom("turn_1"))).toBe("superseded");
    expect(nodeIds(store)).toEqual(["a", "b", "c"]);
  });

  it("knows nothing of a turn from before this page loaded", () => {
    const store = storeAfterAgentTurn();

    expect(store.get(agentTurnUndoStateAtom("turn_from_storage"))).toBe(
      "unknown"
    );
  });
});
