import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  outlineRowElementId,
  WorkflowOutline,
} from "#src/components/workflow/outline/workflow-outline";
import { collapsedGroupIdsAtom } from "#src/lib/collapsed-groups";
import { commandPaletteAtom } from "#src/lib/command-palette-store";
import type { ExecutionLog } from "#src/lib/execution-logs";
import {
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
  projectRunLogsAtom,
  projectRunProgressAtom,
  selectOnlyNodeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import {
  beginPublicationReviewAtom,
  installPublicationReviewAtom,
} from "#src/lib/workflow-publication-review-store";
import {
  reviewHighlightAtom,
  reviewScrollRequestAtom,
} from "#src/lib/workflow-review-store";
import {
  currentWorkflowIdAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import {
  savedWorkflow,
  unreadableDraft,
} from "#src/lib/workflow-save-test-support";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import { toEditorEdge, toEditorNode } from "#src/lib/workflow-graph-types";
import type { RunNodeEvidenceStatus } from "@wfgraph/shared/graph/group-run-status";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import {
  heroGraph,
  outlineTestCatalog,
  SETTLED,
} from "@wfgraph/shared/graph/workflow-outline-test-support";

afterEach(() => {
  cleanup();
});

function runLog(
  nodeId: string,
  status: ExecutionLog["status"],
  output?: unknown
): ExecutionLog {
  return {
    id: `log-${nodeId}`,
    nodeId,
    nodeName: nodeId,
    nodeType: "action",
    status,
    startedAt: new Date(2026, 10, 25, 9, 14, 2),
    completedAt: status === "running" ? null : new Date(2026, 10, 25, 9, 14, 3),
    duration: null,
    output,
    error: null,
    retries: 0,
    retryLimit: 3,
  };
}

/** The run the approved design shows: waiting in the Group, failed at step 10. */
const SEEDED_RUN_LOGS: ExecutionLog[] = [
  runLog("Enough time for reminders?", "success", { condition: true }),
  runLog("Send booking confirmation", "success"),
  runLog("Wait until 24 hours before", "running"),
  runLog("Wait for deposit or reschedule", "success"),
  runLog("Deposit or reschedule?", "success", { event: SETTLED }),
  runLog("Deposit covers the visit?", "success", { condition: true }),
  runLog("Send deposit receipt", "error"),
];

function renderOutline(
  options: {
    comparison?: WorkflowComparisonPayload;
    /** Open the run the design shows: waiting in the Group, failed at step 10. */
    run?: boolean;
    /** The Overlapping runs rule the seeded workflow's start holds. */
    concurrency?: "newest-wins" | "first-wins" | "unlimited";
  } = {}
) {
  const store = createStore();
  const seeded = heroGraph();
  const hero = toWorkflowGraphData(
    createSerializedWorkflowGraph({
      ...seeded,
      nodes: seeded.nodes.map((node) =>
        node.data.type === "lifecycle" && options.concurrency
          ? {
              ...node,
              data: {
                ...node.data,
                config: {
                  lifecycleRules: {
                    ...(node.data.config?.lifecycleRules as object),
                    concurrency: options.concurrency,
                  },
                },
              },
            }
          : node
      ),
    })
  );
  store.set(currentWorkflowIdAtom, "workflow_1");
  // A graph edit saves the draft; the save resolves with the draft as saved.
  store.set(workflowApiAtom, {
    update: vi.fn(() => Promise.resolve(savedWorkflow("workflow_1"))) as never,
    read: unreadableDraft,
  });
  store.set(loadWorkflowGraphAtom, {
    nodes: hero.nodes.map(toEditorNode),
    edges: hero.edges.map(toEditorEdge),
  });
  showWorkspaceRoute(store, {});
  if (options.run) {
    showWorkspaceRoute(store, { view: "runs" });
    store.set(executionOverlayGraphAtom, {
      nodes: hero.nodes.map(toEditorNode),
      edges: hero.edges.map(toEditorEdge),
    });
    store.set(projectRunLogsAtom, {
      executionStatus: "running",
      logs: SEEDED_RUN_LOGS,
    });
    store.set(projectRunProgressAtom, {
      executionStatus: "running",
      statuses: SEEDED_RUN_LOGS.map(
        (log): { nodeId: string; status: RunNodeEvidenceStatus } => ({
          nodeId: log.nodeId,
          status: log.status === "running" ? "waiting" : log.status,
        })
      ),
    });
  }
  const queryClient = new QueryClient();
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
      <QueryClientProvider client={queryClient}>
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
      </QueryClientProvider>
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
  it("says under Starts when what a newer start does to the run in progress", async () => {
    renderOutline({ concurrency: "newest-wins" });
    const view = within(await tree());

    expect(
      view.getByText(
        "A newer Appointment created ends the run in progress. Its steps not yet reached never run."
      )
    ).toBeTruthy();
  });

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

  it("selects a step inside a Group on the one canvas, drawing its Group in place", async () => {
    const { router, store } = renderOutline();
    await tree();
    act(() =>
      store.set(collapsedGroupIdsAtom, new Set(["Pre-visit reminders"]))
    );

    fireEvent.click(row("Send 24-hour reminder"));

    await waitFor(() =>
      expect(store.get(selectedNodeAtom)).toBe("Send 24-hour reminder")
    );
    expect(store.get(collapsedGroupIdsAtom).has("Pre-visit reminders")).toBe(
      false
    );
    expect(router.state.location.search).toEqual({});
  });

  it("puts the pointed tint on a row's card while the row is pointed at", async () => {
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

    // The last row is the open end after the last step, which selects
    // nothing; the row above it is that step.
    fireEvent.keyDown(list, { key: "End" });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Add a step")
    );
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(store.get(activeSelectionAtom).nodeIds).toEqual([
      "Send cancellation notice",
    ]);
  });

  it("offers Add a step at every open end, which opens the picker on that outlet", async () => {
    const { store } = renderOutline();
    const list = await tree();

    // After step 6 at the end of the Group, after steps 11, 13, 15 and 16,
    // and under the two Otherwise outlets nothing is connected behind.
    const adds = within(list).getAllByRole("treeitem", { name: "Add a step" });
    expect(adds).toHaveLength(7);

    const otherwise = document.getElementById(
      outlineRowElementId("add:Enough time for reminders?:false")
    );
    if (!otherwise) throw new Error("no Add a step under the outer Otherwise");
    fireEvent.click(otherwise);
    expect(store.get(commandPaletteAtom)?.pages).toEqual([
      {
        id: "add-step",
        after: { nodeId: "Enough time for reminders?", handle: "false" },
      },
    ]);
    expect(document.activeElement).toBe(otherwise);
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

  it("states what a run did at each step and folds what it did not take", async () => {
    renderOutline({ run: true });
    const list = await tree();

    expect(within(list).getByText("What happened")).toBeTruthy();
    expect(row("Enough time for reminders?").textContent).toContain(
      "Took True"
    );
    // The first step finished names its time; the next, finished in the same
    // second, does not repeat it.
    expect(row("Enough time for reminders?").textContent).toMatch(/:03$/u);
    expect(row("Send booking confirmation").textContent).toMatch(/Completed$/u);
    // Each outcome sits on its own line, outside the label's truncation, so
    // it reads whole at any depth.
    for (const outcome of list.querySelectorAll('[data-slot="run-outcome"]')) {
      expect(outcome.closest(".truncate")).toBeNull();
    }
    expect(
      within(row("Deposit or reschedule?")).getByText(/^Took Payment settled/u)
        .dataset.slot
    ).toBe("run-outcome");
    expect(row("Pre-visit reminders").textContent).toContain("Waiting");
    expect(within(list).getByText("3 steps not reached yet")).toBeTruthy();
    expect(row("Deposit or reschedule?").textContent).toContain(
      "Took Payment settled"
    );
    expect(row("Send deposit receipt").textContent).toContain("Failed");
    // A step past the failure can no longer be reached, while the run goes on.
    expect(row("Send intake form").textContent).toMatch(/Not reached$/u);
    expect(
      within(list).getByText("Otherwise · 2 steps not taken")
    ).toBeTruthy();
    expect(
      within(list).getByText("When Appointment rescheduled · 2 steps not taken")
    ).toBeTruthy();
    expect(
      within(list).getByText("Appointment canceled · has not happened")
    ).toBeTruthy();
    // Rows behind an outlet the run did not take fold away.
    expect(screen.queryByText("Release the slot")).toBeNull();
    expect(screen.queryByText("Send cancellation notice")).toBeNull();
  });

  it("moves a step within its sequence with Alt+Up and Alt+Down, and refuses what cannot move", async () => {
    const { store } = renderOutline();
    const list = await tree();

    act(() => store.set(selectOnlyNodeAtom, "Send deposit receipt"));
    fireEvent.keyDown(list, { key: "ArrowDown", altKey: true });
    await waitFor(() =>
      expect(row("Send intake form").textContent).toMatch(/^10/u)
    );
    expect(row("Send deposit receipt").textContent).toMatch(/^11/u);
    // The moved step keeps the selection and the keyboard.
    expect(store.get(activeSelectionAtom).nodeIds).toEqual([
      "Send deposit receipt",
    ]);

    fireEvent.keyDown(list, { key: "ArrowUp", altKey: true });
    await waitFor(() =>
      expect(row("Send deposit receipt").textContent).toMatch(/^10/u)
    );
  });
});
