import { fireEvent, render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  WorkflowContextMenu,
  type ContextMenuState,
} from "#src/components/workflow/workflow-context-menu";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const catalog: ExtensionCatalog = { actions: [], events: [], integrations: [] };

function actionNode(enabled?: boolean): WorkflowNode {
  return {
    id: "action_1",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Send email",
      type: "action",
      config: { actionType: "email/send" },
      ...(enabled === undefined ? {} : { enabled }),
    },
  };
}

function renderNodeMenu(node: WorkflowNode) {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, { nodes: [node], edges: [] });
  const menuState: ContextMenuState = {
    type: "node",
    nodeId: node.id,
    position: { x: 0, y: 0 },
  };
  const view = render(
    <JotaiProvider store={store}>
      <ExtensionCatalogProvider value={catalog}>
        <OverlayProvider>
          <WorkflowContextMenu
            canEdit
            menuState={menuState}
            onClose={() => {}}
          />
        </OverlayProvider>
      </ExtensionCatalogProvider>
    </JotaiProvider>
  );

  return { ...view, store };
}

describe("WorkflowContextMenu", () => {
  it("toggles the selected node between enabled and disabled", () => {
    const { getByRole, store } = renderNodeMenu(actionNode());

    fireEvent.click(getByRole("button", { name: "Disable Send email" }));

    expect(store.get(nodesAtom)[0]?.data.enabled).toBe(false);
  });

  it("restores the default on state instead of writing enabled: true", () => {
    const { getByRole, store } = renderNodeMenu(actionNode(false));

    fireEvent.click(getByRole("button", { name: "Enable Send email" }));

    expect(store.get(nodesAtom)[0]?.data.enabled).toBeUndefined();
  });
});
