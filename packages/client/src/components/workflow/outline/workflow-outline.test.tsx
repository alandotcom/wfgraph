import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { WorkflowOutline } from "#src/components/workflow/outline/workflow-outline";
import { commandPaletteAtom } from "#src/lib/command-palette-store";
import {
  loadWorkflowGraphAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import {
  beginPublicationReviewAtom,
  installPublicationReviewAtom,
} from "#src/lib/workflow-publication-review-store";
import {
  reviewHighlightAtom,
  reviewScrollRequestAtom,
} from "#src/lib/workflow-review-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import { toEditorEdge, toEditorNode } from "#src/lib/workflow-graph-types";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import {
  heroGraph,
  outlineTestCatalog,
} from "@wfgraph/shared/graph/workflow-outline-test-support";

afterEach(() => {
  cleanup();
});

function renderOutline(
  options: { comparison?: WorkflowComparisonPayload } = {}
) {
  const store = createStore();
  const hero = toWorkflowGraphData(createSerializedWorkflowGraph(heroGraph()));
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(loadWorkflowGraphAtom, {
    nodes: hero.nodes.map(toEditorNode),
    edges: hero.edges.map(toEditorEdge),
  });
  showWorkspaceRoute(store, {});
  if (options.comparison) {
    const epoch = store.set(beginPublicationReviewAtom, "workflow_1");
    if (epoch !== null) {
      store.set(installPublicationReviewAtom, {
        workflowId: "workflow_1",
        epoch,
        pending: false,
        graph: options.comparison.draftGraph,
        expectedDraftRevision: 1,
        expectedPublishedVersionId: null,
        payload: options.comparison,
      });
    }
  }
  const rootRoute = createRootRoute({
    component: () => (
      <Provider store={store}>
        <ExtensionCatalogProvider value={outlineTestCatalog}>
          <IntegrationUiProvider value={{}}>
            <OverlayProvider>
              <div style={{ height: 600, width: 340 }}>
                <WorkflowOutline />
              </div>
            </OverlayProvider>
          </IntegrationUiProvider>
        </ExtensionCatalogProvider>
      </Provider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/workflows/workflow_1"] }),
  });
  return { ...render(<RouterProvider router={router} />), router, store };
}

async function tree() {
  return await screen.findByRole("tree", { name: "Outline" });
}

function row(name: string): HTMLElement {
  const found = screen
    .getAllByRole("treeitem")
    .find((item) => item.textContent?.includes(name));
  if (!found) throw new Error(`No row holds "${name}"`);
  return found;
}

describe("WorkflowOutline", () => {
  it("lists the seeded workflow in run order with numbers, outlet labels and sections", async () => {
    renderOutline();
    const view = within(await tree());

    expect(view.getByText("Starts when")).toBeTruthy();
    expect(view.getByText("Stops when")).toBeTruthy();
    expect(view.getByText("At the same time")).toBeTruthy();
    expect(view.getByText("When Payment settled")).toBeTruthy();
    expect(view.getAllByText("Otherwise, the path ends")).toHaveLength(2);
    const numbered = screen
      .getAllByRole("treeitem")
      .map((item) => item.textContent ?? "")
      .filter((text) => /^\d+/u.test(text));
    expect(numbered[0]).toMatch(/^1If Enough time for reminders\?/u);
    expect(numbered.at(-1)).toMatch(/^16Send cancellation notice/u);
    expect(row("Pre-visit reminders").getAttribute("aria-expanded")).toBe(
      "true"
    );
  });

  it("selects a step the way a card press does, and highlights the row a card selection names", async () => {
    const { store } = renderOutline();
    await tree();

    fireEvent.click(row("Send booking confirmation"));
    expect(store.get(activeSelectionAtom).nodeIds).toEqual([
      "Send booking confirmation",
    ]);

    act(() => store.set(selectOnlyNodeAtom, "Release the slot"));
    expect(row("Release the slot").getAttribute("aria-selected")).toBe("true");
    expect(row("Send booking confirmation").getAttribute("aria-selected")).toBe(
      "false"
    );
  });

  it("enters the Group to select a step inside it", async () => {
    const { router } = renderOutline();
    await tree();

    fireEvent.click(row("Send 24-hour reminder"));

    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        group: "Pre-visit reminders",
      })
    );
  });

  it("puts the halo on a row's card while the row is pointed at", async () => {
    const { store } = renderOutline();
    await tree();

    fireEvent.pointerEnter(row("Alert the front desk"));
    expect(store.get(reviewHighlightAtom)).toBe("Alert the front desk");
    fireEvent.pointerLeave(row("Alert the front desk"));
    expect(store.get(reviewHighlightAtom)).toBeNull();
  });

  it("moves through rows with the arrow keys and folds with Left and Right", async () => {
    const { store } = renderOutline();
    const list = await tree();
    const items = () => screen.getAllByRole("treeitem");
    // One Tab stop.
    expect(items().filter((item) => item.tabIndex === 0)).toHaveLength(1);

    act(() => store.set(selectOnlyNodeAtom, "Deposit covers the visit?"));
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(store.get(activeSelectionAtom).nodeIds).toEqual([
      "Send deposit receipt",
    ]);
    await waitFor(() =>
      expect(document.activeElement).toBe(row("Send deposit receipt"))
    );

    // Left goes to the Condition the step sits under, then folds it.
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(document.activeElement).toBe(row("Deposit covers the visit?"))
    );
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(screen.queryByText("Release the slot")).toBeNull();
    expect(row("Deposit covers the visit?").getAttribute("aria-expanded")).toBe(
      "false"
    );
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(row("Release the slot")).toBeTruthy();

    fireEvent.keyDown(list, { key: "End" });
    expect(store.get(activeSelectionAtom).nodeIds).toEqual([
      "Send cancellation notice",
    ]);
  });

  it("filters rows by text, and Cmd+F focuses the filter", async () => {
    renderOutline();
    await tree();
    const filter = screen.getByRole("searchbox", { name: "Filter steps" });

    fireEvent.keyDown(document, { key: "f", metaKey: true });
    expect(document.activeElement).toBe(filter);

    fireEvent.change(filter, { target: { value: "intake" } });
    const names = screen
      .getAllByRole("treeitem")
      .map((item) => item.textContent ?? "");
    expect(names.some((text) => text.includes("Send intake form"))).toBe(true);
    // The rows it sits under stay, so the match reads in place.
    expect(
      names.some((text) => text.includes("Deposit covers the visit?"))
    ).toBe(true);
    expect(names.some((text) => text.includes("Release the slot"))).toBe(false);
  });

  it("marks changed rows while the review sheet shows and scrolls the sheet to a pressed edit", async () => {
    const { nodes, edges } = heroGraph();
    const draft = createSerializedWorkflowGraph({ nodes, edges });
    const { store } = renderOutline({
      comparison: {
        baseVersion: null,
        proposedVersion: 3,
        baseGraph: draft,
        draftGraph: draft,
        hasChanges: true,
        nodeChanges: [
          { nodeId: "Send intake form", kind: "modified", fields: [] },
        ],
        edgeChanges: [],
      },
    });
    await tree();

    const changed = row("Send intake form");
    expect(within(changed).getByTitle("Modified")).toBeTruthy();
    fireEvent.click(changed);
    expect(store.get(reviewScrollRequestAtom)?.nodeId).toBe("Send intake form");
    expect(store.get(activeSelectionAtom).nodeIds).toEqual([]);
  });

  it("opens the step picker after a step with /, and refuses a Condition's row", async () => {
    const { store } = renderOutline();
    const list = await tree();

    act(() => store.set(selectOnlyNodeAtom, "Deposit covers the visit?"));
    fireEvent.keyDown(list, { key: "/" });
    expect(store.get(commandPaletteAtom)).toBeNull();

    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "/" });
    expect(store.get(activeSelectionAtom).nodeIds).toEqual([
      "Send deposit receipt",
    ]);
    expect(store.get(commandPaletteAtom)?.pages).toEqual([{ id: "add-step" }]);
  });
});
