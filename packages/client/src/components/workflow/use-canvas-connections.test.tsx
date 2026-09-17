import { act, renderHook } from "@testing-library/react";
import { Provider as JotaiProvider } from "jotai";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import {
  canvasNodesAtom,
  edgesAtom,
  groupSelectionAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import {
  createGraphStore,
  graphOf,
  ungroupedGraph,
  type Store,
} from "#src/lib/workflow-group-mutations-test-support";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { connectionRefusalReason } from "./connection-validation";
import { useCanvasConnections } from "./use-canvas-connections";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [],
  actions: [],
};

/** `a`, `b` and `c` grouped and the Group entered, with its frame id. */
function enteredStore(): { store: Store; frameId: string } {
  const store = createGraphStore(ungroupedGraph());
  store.set(groupSelectionAtom, { selectedIds: new Set(["a", "b", "c"]) });
  const frameId = store.get(nodesAtom).find((node) => isGroupNode(node))?.id;
  if (!frameId) {
    throw new Error("expected the fixture to group");
  }
  showWorkspaceRoute(store, { group: frameId });
  return { store, frameId };
}

/** The hook as the canvas mounts it on the store's active scope. */
function renderConnections(store: Store) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <JotaiProvider store={store}>{children}</JotaiProvider>
  );
  return renderHook(
    () =>
      useCanvasConnections({
        nodes: store.get(canvasNodesAtom),
        graphNodes: store.get(nodesAtom),
        storeEdges: store.get(edgesAtom),
        catalog,
        connectionsLocked: false,
        insertsNodes: true,
        screenToFlowPosition: (position) => position,
      }),
    { wrapper }
  );
}

beforeEach(() => {
  vi.spyOn(toast, "info").mockImplementation(() => "id");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useCanvasConnections on a focused Group", () => {
  it("shows the planner's notice for a refused connection between members and changes nothing", () => {
    const { store } = enteredStore();
    const before = graphOf(store);
    const connection = {
      source: "a",
      target: "b",
      sourceHandle: null,
      targetHandle: null,
    };
    const refusal = connectionRefusalReason({
      connection,
      nodes: store.get(nodesAtom),
      storeEdges: store.get(edgesAtom),
      catalog,
    });
    expect(refusal).not.toBeNull();
    const { result } = renderConnections(store);

    expect(result.current.isValidConnection(connection)).toBe(false);
    act(() => {
      result.current.onConnect(connection);
    });

    expect(toast.info).toHaveBeenCalledWith(refusal, {
      id: "connection-refused",
    });
    expect(graphOf(store)).toEqual(before);
  });

  it("adds a step dragged out of a member into empty canvas as a connected member", () => {
    const { store, frameId } = enteredStore();
    const { result } = renderConnections(store);
    const pane = document.createElement("div");

    act(() => {
      result.current.onConnectStart(new MouseEvent("mousedown"), {
        nodeId: "a",
        handleId: null,
        handleType: "source",
      });
      result.current.onConnectEnd(
        { target: pane, clientX: 40, clientY: 400 } as unknown as MouseEvent,
        { isValid: false } as never
      );
    });

    const added = store
      .get(nodesAtom)
      .find(
        (node) => !["life", "a", "b", "c", "after", frameId].includes(node.id)
      );
    expect(added?.parentId).toBe(frameId);
    expect(
      store
        .get(edgesAtom)
        .filter((item) => item.target === added?.id)
        .map((item) => item.source)
    ).toEqual(["a"]);
    expect(toast.info).not.toHaveBeenCalled();
  });
});
