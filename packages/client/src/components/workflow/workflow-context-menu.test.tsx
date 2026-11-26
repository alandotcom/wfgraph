import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, within } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayContainer } from "#src/components/overlays/overlay-container";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  WorkflowContextMenu,
  type ContextMenuState,
} from "#src/components/workflow/workflow-context-menu";
import {
  edgesAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";

const catalog: ExtensionCatalog = {
  actions: [],
  entities: [],
  events: [],
  integrations: [],
};

function actionNode(enabled?: boolean): WorkflowNode {
  return {
    id: "action_1",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Send email",
      type: "action",
      config: { actionType: "email/send" },
      enabled,
    },
  };
}

/** A frame holding two lookups, the first feeding the second. */
function groupGraph(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const member = (id: string, label: string): WorkflowNode => ({
    id,
    type: "action",
    parentId: "group_1",
    extent: "parent",
    position: { x: 0, y: 0 },
    data: {
      label,
      type: "action",
      config: { actionType: "fountain/get-user" },
    },
  });
  return {
    nodes: [
      {
        id: "group_1",
        type: "group",
        position: { x: 0, y: 0 },
        width: 400,
        height: 300,
        data: { label: "Lookups", type: "group" },
      },
      member("a", "Load user"),
      member("b", "Load account"),
    ],
    edges: [{ id: "a-b", source: "a", target: "b" }],
  };
}

function renderNodeMenu(
  node: WorkflowNode | string,
  graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] } = {
    nodes: typeof node === "string" ? [] : [node],
    edges: [],
  }
) {
  return renderMenu(
    {
      type: "node",
      nodeId: typeof node === "string" ? node : node.id,
      position: { x: 0, y: 0 },
    },
    graph
  );
}

function renderMenu(
  menuState: ContextMenuState,
  graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }
) {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, graph);
  const view = render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={new QueryClient()}>
        <ExtensionCatalogProvider value={catalog}>
          <OverlayProvider>
            <WorkflowContextMenu menuState={menuState} onClose={() => {}} />
            <OverlayContainer />
          </OverlayProvider>
        </ExtensionCatalogProvider>
      </QueryClientProvider>
    </JotaiProvider>
  );

  return { ...view, store };
}

beforeEach(() => {
  installAuthorizationGrantsForTests([WfGraphOperations.workflowUpdate.id]);
});
afterEach(resetAuthorizationGrantsForTests);

describe("WorkflowContextMenu", () => {
  it("toggles the selected node between enabled and disabled", () => {
    const { getByRole, store } = renderNodeMenu(actionNode());

    fireEvent.click(getByRole("button", { name: "Disable Send email" }));

    expect(store.get(nodesAtom)[0]?.data.enabled).toBe(false);
  });

  it("dims a disabled row's label and leaves its reason at full contrast", () => {
    const { getByRole } = renderNodeMenu(actionNode());

    const row = getByRole("button", { name: /^Group/ });
    expect(row).toHaveProperty("disabled", true);
    expect(row.className).not.toContain("opacity-50");
    const label = within(row).getByText("Group");
    const reason = within(row).getByText(/two steps/);
    expect(label.className).toContain("opacity-50");
    expect(reason.className).not.toContain("opacity-50");
  });

  it("restores the default on state instead of writing enabled: true", () => {
    const { getByRole, store } = renderNodeMenu(actionNode(false));

    fireEvent.click(getByRole("button", { name: "Enable Send email" }));

    expect(store.get(nodesAtom)[0]?.data.enabled).toBeUndefined();
  });

  it("offers a frame no enabled state and no plain delete", () => {
    const { queryByRole } = renderNodeMenu("group_1", groupGraph());

    expect(queryByRole("button", { name: /^(Enable|Disable) / })).toBeNull();
    expect(queryByRole("button", { name: "Delete Lookups" })).toBeNull();
    expect(queryByRole("button", { name: "Ungroup" })).not.toBeNull();
  });

  it("deletes a Group and its steps only after the person confirms", async () => {
    const { findByRole, getByRole, store } = renderNodeMenu(
      "group_1",
      groupGraph()
    );

    fireEvent.click(getByRole("button", { name: "Delete Group and steps" }));

    const dialog = await findByRole("dialog");
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual([
      "group_1",
      "a",
      "b",
    ]);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete Group and steps" })
    );

    expect(store.get(nodesAtom)).toEqual([]);
    expect(store.get(edgesAtom)).toEqual([]);
  });

  // Undo restores a deleted connection, as it restores a deleted step, so
  // neither asks for confirmation.
  it("deletes a connection at once, with no confirmation", () => {
    const { getByRole, queryByRole, store } = renderMenu(
      { type: "edge", edgeId: "a-b", position: { x: 0, y: 0 } },
      groupGraph()
    );

    fireEvent.click(getByRole("button", { name: "Delete connection" }));

    expect(queryByRole("dialog")).toBeNull();
    expect(store.get(edgesAtom)).toEqual([]);
  });

  it("switches a Group member off by itself", () => {
    const { getByRole, store } = renderNodeMenu("a", groupGraph());

    fireEvent.click(getByRole("button", { name: "Disable Load user" }));

    const nodes = store.get(nodesAtom);
    expect(nodes.find((node) => node.id === "a")?.data.enabled).toBe(false);
    expect(nodes.find((node) => node.id === "b")?.data.enabled).toBeUndefined();
    expect(nodes.find((node) => node.id === "group_1")?.data).toEqual({
      label: "Lookups",
      type: "group",
    });
  });

  describe("with two steps selected", () => {
    /** Two steps outside any Group, both selected when the menu opened. */
    function twoSteps(enabled?: boolean): WorkflowNode[] {
      return ["one", "two"].map((id, index) => ({
        id,
        type: "action",
        position: { x: 0, y: index * 200 },
        data: {
          label: `Step ${id}`,
          type: "action",
          config: { actionType: "email/send" },
          enabled,
        },
      }));
    }
    function renderBulkMenu(enabled?: boolean) {
      return renderMenu(
        {
          type: "node",
          nodeId: "one",
          position: { x: 0, y: 0 },
          selectedIds: new Set(["one", "two"]),
        },
        { nodes: twoSteps(enabled), edges: [] }
      );
    }

    it("names the count and offers only what applies to both", () => {
      const { getAllByRole } = renderBulkMenu();

      expect(
        getAllByRole("button").map((row) =>
          row.textContent?.replace(/⌘.|Ctrl\+./u, "")
        )
      ).toEqual([
        "Group 2 steps",
        "Duplicate 2 steps",
        "Copy",
        "Disable 2 steps",
        "Delete 2 steps",
      ]);
    });

    it("disables both steps in one go, and enables them again", () => {
      const { getByRole, store } = renderBulkMenu();
      fireEvent.click(getByRole("button", { name: "Disable 2 steps" }));
      expect(store.get(nodesAtom).map((node) => node.data.enabled)).toEqual([
        false,
        false,
      ]);
    });

    it("offers Enable when both steps are off", () => {
      const { getByRole } = renderBulkMenu(false);
      expect(getByRole("button", { name: "Enable 2 steps" })).toBeTruthy();
    });

    it("deletes both steps", () => {
      const { getByRole, store } = renderBulkMenu();
      fireEvent.click(getByRole("button", { name: "Delete 2 steps" }));
      expect(store.get(nodesAtom)).toEqual([]);
    });
  });
});
