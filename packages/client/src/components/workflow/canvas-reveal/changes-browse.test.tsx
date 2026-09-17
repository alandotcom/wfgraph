import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import type { WorkflowNode as PersistedWorkflowNode } from "@wfgraph/shared/graph/types";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { CanvasReveal } from "#src/components/workflow/canvas-reveal/canvas-reveal";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcErrorResponse,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import {
  beginWorkflowComparisonRequestAtom,
  comparisonSessionAtom,
  installWorkflowComparisonAtom,
  moveComparisonNodesAtom,
  settleWorkflowComparisonRequestAtom,
} from "#src/lib/workflow-comparison-store";
import { historyAtom } from "#src/lib/workflow-graph-cells";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { workspaceAddressFromSearch } from "#src/lib/workflow-navigation-state";
import { toEditorNode } from "#src/lib/workflow-graph-types";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  hasUnsavedChangesAtom,
} from "#src/lib/workflow-save-store";
import {
  activeDesktopRevealLevelAtom,
  activeSelectionAtom,
  activeWorkspaceCamerasAtom,
  recordWorkspaceCameraAtom,
} from "#src/lib/workflow-workspace-navigation";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";

const WORKFLOW_ID = "wf_1";
const CHANGES_V3: WorkflowRouteSearch = {
  view: "changes",
  compare: "version_3",
};

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [],
  actions: [],
};

function step(id: string, label: string): PersistedWorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label, type: "action" },
  };
}

function comparisonAgainst(version: number): WorkflowComparisonPayload {
  return {
    baseVersion: {
      id: `version_${version}`,
      version,
      publishedAt: "2026-09-01T00:00:00.000Z",
      isCurrent: version === 3,
    },
    proposedVersion: 4,
    baseGraph: createSerializedWorkflowGraph({
      nodes: [
        step("kept", "Kept"),
        step("gone", "Gone"),
        step("edited", "Old"),
      ],
      edges: [{ id: "kept-gone", source: "kept", target: "gone" }],
    }),
    draftGraph: createSerializedWorkflowGraph({
      nodes: [
        step("kept", "Kept"),
        step("edited", "New"),
        step("fresh", "Fresh"),
      ],
      edges: [{ id: "kept-fresh", source: "kept", target: "fresh" }],
    }),
    hasChanges: true,
    nodeChanges: [
      { nodeId: "fresh", kind: "added", fields: [] },
      { nodeId: "edited", kind: "modified", fields: [] },
      { nodeId: "gone", kind: "removed", fields: [] },
    ],
    edgeChanges: [
      { edgeId: "kept-fresh", kind: "added" },
      { edgeId: "kept-gone", kind: "removed" },
    ],
  };
}

/**
 * The server these cases talk to: each comparison request's base, answered by
 * `answerComparison` (a comparison against version 3 by default), and one page
 * of version history.
 */
function stubServer() {
  const server = {
    comparisonRequests: [] as Array<string | undefined>,
    answerComparison: (): Promise<Response> | Response =>
      rpcJsonResponse(comparisonAgainst(3)),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = extractRpcProcedurePath(rpcUrl(url));
      const input = await parseRpcRequestInput(init);
      if (path === "workflow/compareVersion") {
        server.comparisonRequests.push(
          typeof input.baseVersionId === "string"
            ? input.baseVersionId
            : undefined
        );
        return server.answerComparison();
      }
      if (path === "workflow/getVersionHistory") {
        return rpcJsonResponse({
          items: [1, 2, 3].map((version) => ({
            id: `version_${version}`,
            version,
            publishedAt: "2026-09-01T00:00:00.000Z",
            isCurrent: version === 3,
          })),
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected RPC ${path}`);
    })
  );
  return server;
}

type Store = ReturnType<typeof createStore>;

/** Install a comparison through the request epochs, as a response does. */
function installComparison(store: Store, payload: WorkflowComparisonPayload) {
  const epoch = store.set(beginWorkflowComparisonRequestAtom, WORKFLOW_ID);
  store.set(installWorkflowComparisonAtom, {
    workflowId: WORKFLOW_ID,
    epoch,
    payload,
  });
  store.set(settleWorkflowComparisonRequestAtom, {
    workflowId: WORKFLOW_ID,
    epoch,
  });
}

async function renderChanges(options?: {
  search?: WorkflowRouteSearch;
  installed?: WorkflowComparisonPayload | null;
}) {
  const search = options?.search ?? CHANGES_V3;
  const store = createStore();
  store.set(loadWorkflowGraphAtom, {
    nodes: [
      step("kept", "Kept"),
      step("edited", "New"),
      step("fresh", "Fresh"),
    ].map(toEditorNode),
    edges: [],
  });
  store.set(currentWorkflowIdAtom, WORKFLOW_ID);
  store.set(currentWorkflowNameAtom, "Appointment reminders");
  showWorkspaceRoute(store, search);
  const installed =
    options?.installed === undefined ? comparisonAgainst(3) : options.installed;
  if (installed) {
    installComparison(store, installed);
  }

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (input: WorkflowRouteSearch & SearchSchemaInput) =>
      authorizedWorkflowSearch(input, {
        canOpenRuns: true,
        canOpenComparison: true,
      }),
    component: () => (
      <div className="relative" data-testid="canvas-area">
        <CanvasReveal />
      </div>
    ),
  });
  const query = new URLSearchParams(
    Object.entries(search).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  ).toString();
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [`/workflows/${WORKFLOW_ID}?${query}`],
    }),
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const view = render(
    <ExtensionCatalogProvider value={catalog}>
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <ReactFlowProvider>
            <OverlayProvider>
              <RouterProvider router={router} />
            </OverlayProvider>
          </ReactFlowProvider>
        </JotaiProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );
  await view.findByTestId("canvas-area");
  const aside = () => {
    const element = view.container.querySelector<HTMLElement>(
      '[data-slot="canvas-reveal"]'
    );
    if (!element) {
      throw new Error("Canvas Reveal did not render");
    }
    return element;
  };
  const inReveal = () => within(aside());
  const list = () =>
    aside().querySelector<HTMLElement>('[data-slot="change-list"]');
  const click = (name: string | RegExp) =>
    fireEvent.click(inReveal().getByRole("button", { name }));
  const show = async (next: WorkflowRouteSearch) => {
    await act(async () => {
      showWorkspaceRoute(store, next);
    });
  };
  return { view, store, router, aside, inReveal, list, click, show };
}

beforeEach(() => {
  installAuthorizationGrantsForTests([
    WfGraphOperations.workflowCompareVersion.id,
    WfGraphOperations.workflowGetVersionHistory.id,
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthorizationGrantsForTests();
});

describe("Changes Browse orientation", () => {
  it("names the comparison pair and proposed version and summarizes node and connection changes", async () => {
    stubServer();
    const { view, aside, inReveal } = await renderChanges();

    expect(aside().dataset.level).toBe("browse");
    expect(view.getByRole("complementary", { name: "Changes inspector" })).toBe(
      aside()
    );
    expect(
      inReveal().getByRole("heading", {
        name: "Version 3 → proposed version 4",
      })
    ).toBeTruthy();
    expect(aside().querySelector("[data-slot=reveal-path]")?.textContent).toBe(
      "Appointment reminders › Version 3 → proposed version 4"
    );
    const summary = inReveal().getByRole("region", {
      name: "Comparison summary",
    });
    expect(summary.textContent).toContain(
      "Steps1 added, 1 modified, 1 removed"
    );
    expect(summary.textContent).toContain("Connections1 added, 1 removed");
  });

  it("keeps added, modified, and removed objects distinct in the list", async () => {
    stubServer();
    const { inReveal } = await renderChanges();

    const steps = inReveal().getByRole("region", { name: "Changed steps" });
    const connections = inReveal().getByRole("region", {
      name: "Changed connections",
    });
    const rows = (region: HTMLElement) =>
      within(region)
        .getAllByRole("button")
        .map((row) => ({
          name: row.textContent,
          change: row.dataset.change,
          marker: row.querySelector("[aria-hidden=true]")?.className,
        }));
    expect(rows(steps).map(({ name, change }) => [name, change])).toEqual([
      ["AFreshAdded", "added"],
      ["MNewModified", "modified"],
      ["DGoneRemoved", "removed"],
    ]);
    expect(rows(connections).map(({ name }) => name)).toEqual([
      "AKept → FreshAdded",
      "DKept → GoneRemoved",
    ]);
    const [added, modified, removed] = rows(steps).map(({ marker }) => marker);
    expect(added).toContain("text-success");
    expect(modified).toContain("text-warning");
    expect(removed).toContain("text-destructive");
  });
});

describe("Changes Browse navigation", () => {
  it("selects changed steps and connections from the list and Previous and Next", async () => {
    stubServer();
    const { store, inReveal, click } = await renderChanges();

    click("Gone Removed");
    expect(store.get(activeSelectionAtom)).toEqual({
      nodeIds: ["gone"],
      edgeIds: [],
    });
    expect(
      inReveal()
        .getByRole("button", { name: "Gone Removed" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(inReveal().getByText("3 of 5")).toBeTruthy();

    click("Next change");
    expect(store.get(activeSelectionAtom)).toEqual({
      nodeIds: [],
      edgeIds: ["kept-fresh"],
    });
    click("Next change");
    expect(
      inReveal().getByRole("button", { name: "Next change" })
    ).toHaveProperty("disabled", true);
    click("Previous change");
    click("Previous change");
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["gone"]);
  });

  it("highlights a step selected on the canvas", async () => {
    stubServer();
    const { store, inReveal } = await renderChanges();

    await act(async () => {
      store.set(selectOnlyNodeAtom, "edited");
    });
    expect(
      inReveal()
        .getByRole("button", { name: "New Modified" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(inReveal().getByText("2 of 5")).toBeTruthy();
  });

  it("opens, refreshes, and exits a comparison without changing the Draft", async () => {
    const server = stubServer();
    const { store, router, inReveal, click, show } = await renderChanges({
      search: {},
      installed: null,
    });
    await act(async () => {
      store.set(selectOnlyNodeAtom, "fresh");
    });
    const draftSelection = store.get(activeSelectionAtom);
    const draftLevel = store.get(activeDesktopRevealLevelAtom);
    const draftNodes = store.get(nodesAtom);

    await show({ view: "changes" });
    click("Review changes");
    await waitFor(() =>
      expect(
        inReveal().getByRole("heading", {
          name: "Version 3 → proposed version 4",
        })
      ).toBeTruthy()
    );
    expect(server.comparisonRequests).toEqual([undefined]);

    let answer: (response: Response) => void = () => undefined;
    server.answerComparison = () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      });
    click("Refresh comparison");
    await waitFor(() =>
      expect(inReveal().getByText("Refreshing")).toBeTruthy()
    );
    expect(
      inReveal().getByRole("heading", {
        name: "Version 3 → proposed version 4",
      })
    ).toBeTruthy();
    expect(
      inReveal().getByRole("button", { name: "Gone Removed" })
    ).toBeTruthy();
    await act(async () => {
      answer(rpcJsonResponse(comparisonAgainst(3)));
    });
    await waitFor(() =>
      expect(inReveal().queryByText("Refreshing")).toBeNull()
    );
    expect(server.comparisonRequests).toEqual([undefined, "version_3"]);

    click("Exit comparison");
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await show({});
    expect(store.get(activeSelectionAtom)).toEqual(draftSelection);
    expect(store.get(activeDesktopRevealLevelAtom)).toBe(draftLevel);
    expect(store.get(nodesAtom)).toBe(draftNodes);
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(store.get(historyAtom)).toEqual([]);
  });

  it("opens version history in Changes and returns to the same selection and list scroll", async () => {
    stubServer();
    const { store, aside, inReveal, list, click } = await renderChanges();
    click("Gone Removed");
    const scroller = list();
    if (!scroller) {
      throw new Error("the change list did not render");
    }
    scroller.scrollTop = 120;
    fireEvent.scroll(scroller);
    fireEvent(scroller, new Event("scrollend"));

    click("Version history");
    expect(
      await inReveal().findByRole("button", { name: /Version 2/ })
    ).toBeTruthy();
    expect(document.activeElement).toBe(
      inReveal().getByRole("heading", { name: "Version history" })
    );
    expect(aside().querySelector("[data-slot=reveal-path]")?.textContent).toBe(
      "Appointment reminders › Version 3 → proposed version 4 › Version history"
    );
    expect(list()).toBeNull();

    click("Back to changes");
    expect(document.activeElement).toBe(
      inReveal().getByRole("button", { name: "Version history" })
    );
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["gone"]);
    expect(
      inReveal()
        .getByRole("button", { name: "Gone Removed" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    await waitFor(() => expect(list()?.scrollTop).toBe(120));
  });

  it("returns from version history to the change list on Escape, then closes", async () => {
    stubServer();
    const { aside, inReveal, list, click } = await renderChanges();
    click("Version history");
    const heading = await inReveal().findByRole("heading", {
      name: "Version history",
    });

    fireEvent.keyDown(heading, { key: "Escape" });
    expect(list()).not.toBeNull();
    expect(aside().dataset.level).toBe("browse");
    const historyButton = inReveal().getByRole("button", {
      name: "Version history",
    });
    expect(document.activeElement).toBe(historyButton);

    fireEvent.keyDown(historyButton, { key: "Escape" });
    expect(aside().dataset.level).toBe("closed");
  });

  it("offers the layout reset only while a removed step has moved", async () => {
    stubServer();
    const { store, inReveal, click } = await renderChanges();
    const reset = () =>
      inReveal().queryByRole("button", { name: "Reset comparison layout" });
    expect(reset()).toBeNull();

    await act(async () => {
      store.set(moveComparisonNodesAtom, {
        workflowId: WORKFLOW_ID,
        changes: [{ type: "position", id: "gone", position: { x: 40, y: 80 } }],
      });
    });
    expect(reset()).toBeTruthy();

    click("Reset comparison layout");
    expect(reset()).toBeNull();
    expect(document.activeElement).toBe(
      inReveal().getByRole("button", { name: "Version history" })
    );
    expect(store.get(comparisonSessionAtom)?.positionOverrides).toEqual({});
  });
});

describe("Changes Browse states", () => {
  it("shows a loading comparison, then a retryable failure", async () => {
    const server = stubServer();
    const { store, inReveal, click } = await renderChanges({ installed: null });
    const epoch = store.set(beginWorkflowComparisonRequestAtom, WORKFLOW_ID);
    await waitFor(() =>
      expect(
        inReveal().getByText(
          "Comparing current draft with the published version"
        )
      ).toBeTruthy()
    );
    expect(
      inReveal().getByRole("heading", { name: "Comparing changes" })
    ).toBeTruthy();
    expect(
      inReveal().getByRole("button", { name: "Refresh comparison" })
    ).toHaveProperty("disabled", true);

    await act(async () => {
      store.set(settleWorkflowComparisonRequestAtom, {
        workflowId: WORKFLOW_ID,
        epoch,
        outcome: "error",
      });
    });
    expect(inReveal().getByText("Unable to compare changes")).toBeTruthy();
    click("Try again");
    await waitFor(() =>
      expect(server.comparisonRequests).toEqual(["version_3"])
    );
    expect(
      await inReveal().findByRole("heading", {
        name: "Version 3 → proposed version 4",
      })
    ).toBeTruthy();
  });

  it("says when the draft has no changes", async () => {
    stubServer();
    const { inReveal } = await renderChanges({
      installed: {
        ...comparisonAgainst(3),
        hasChanges: false,
        nodeChanges: [],
        edgeChanges: [],
      },
    });
    expect(
      inReveal().getByText("This draft has no changes from version 3.")
    ).toBeTruthy();
    expect(inReveal().getByText("0 changes")).toBeTruthy();
  });

  it("keeps the comparison and reports a failed refresh", async () => {
    const server = stubServer();
    server.answerComparison = () =>
      rpcErrorResponse({
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
        message: "Down",
      });
    const { inReveal, click } = await renderChanges();

    click("Refresh comparison");
    expect(await inReveal().findByText("Refresh failed")).toBeTruthy();
    expect(
      inReveal().getByRole("heading", {
        name: "Version 3 → proposed version 4",
      })
    ).toBeTruthy();
    expect(
      inReveal().getByRole("button", { name: "Gone Removed" })
    ).toBeTruthy();
    expect(
      inReveal().getByRole("button", { name: "Refresh comparison" })
    ).toHaveProperty("disabled", false);
  });

  it("offers no comparison request without permission to compare", async () => {
    installAuthorizationGrantsForTests([
      WfGraphOperations.workflowGetVersionHistory.id,
    ]);
    const server = stubServer();
    const { inReveal } = await renderChanges({ installed: null });

    expect(
      inReveal().getByText(
        "Open a comparison of this draft and its published version."
      )
    ).toBeTruthy();
    expect(
      inReveal().queryByRole("button", { name: "Review changes" })
    ).toBeNull();
    expect(server.comparisonRequests).toEqual([]);
  });
});

describe("Changes Browse comparison context", () => {
  it("never shows an older base while a newer comparison loads, and ignores its late answer", async () => {
    stubServer();
    const { store, inReveal, show } = await renderChanges();
    const staleEpoch = store.set(
      beginWorkflowComparisonRequestAtom,
      WORKFLOW_ID
    );

    await show({ view: "changes", compare: "version_1" });
    const epoch = store.set(beginWorkflowComparisonRequestAtom, WORKFLOW_ID);
    await waitFor(() =>
      expect(
        inReveal().getByRole("heading", { name: "Comparing changes" })
      ).toBeTruthy()
    );
    expect(
      inReveal().queryByRole("button", { name: "Gone Removed" })
    ).toBeNull();

    await act(async () => {
      expect(
        store.set(installWorkflowComparisonAtom, {
          workflowId: WORKFLOW_ID,
          epoch: staleEpoch,
          payload: comparisonAgainst(2),
        })
      ).toBe(false);
    });
    expect(
      inReveal().getByRole("heading", { name: "Comparing changes" })
    ).toBeTruthy();

    await act(async () => {
      store.set(installWorkflowComparisonAtom, {
        workflowId: WORKFLOW_ID,
        epoch,
        payload: comparisonAgainst(1),
      });
      store.set(settleWorkflowComparisonRequestAtom, {
        workflowId: WORKFLOW_ID,
        epoch,
      });
    });
    expect(
      inReveal().getByRole("heading", {
        name: "Version 1 → proposed version 4",
      })
    ).toBeTruthy();
  });

  it("restores the comparison, selection, camera, Reveal level, and list scroll after visiting Draft", async () => {
    stubServer();
    const { store, aside, inReveal, list, click, show } = await renderChanges();
    click("Kept → Gone Removed");
    const scroller = list();
    if (!scroller) {
      throw new Error("the change list did not render");
    }
    scroller.scrollTop = 90;
    fireEvent.scroll(scroller);
    fireEvent(scroller, new Event("scrollend"));
    const camera = { centerX: 320, centerY: 140, zoom: 0.75 };
    store.set(recordWorkspaceCameraAtom, {
      address: workspaceAddressFromSearch(WORKFLOW_ID, CHANGES_V3),
      formFactor: "desktop",
      camera,
    });

    await show({});
    expect(aside().dataset.level).toBe("closed");
    await show(CHANGES_V3);

    expect(aside().dataset.level).toBe("browse");
    expect(store.get(activeSelectionAtom)).toEqual({
      nodeIds: [],
      edgeIds: ["kept-gone"],
    });
    expect(store.get(activeWorkspaceCamerasAtom).desktop).toEqual(camera);
    expect(
      inReveal().getByRole("heading", {
        name: "Version 3 → proposed version 4",
      })
    ).toBeTruthy();
    await waitFor(() => expect(list()?.scrollTop).toBe(90));

    click("Close");
    await show({});
    await show(CHANGES_V3);
    expect(aside().dataset.level).toBe("closed");
  });
});
