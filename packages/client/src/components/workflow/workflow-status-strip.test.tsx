/**
 * The strip's two states, and the three things it is the only surface for: the
 * way out of a pinned run with no panel on screen (#96), the unload guard that
 * used to unmount with the draft state, and the mode label that must say nothing
 * until it knows what to say.
 */

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
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import { WorkflowStatusStrip } from "#src/components/workflow/workflow-status-strip";
import {
  answerWorkflowRunRpc,
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcJsonResponse,
  rpcUrl,
  type WorkflowRunRpcFixture,
} from "#src/lib/rpc-fetch-test-support";
import { canvasEditingLockedAtom } from "#src/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
  hasUnsavedChangesAtom,
  isWorkflowOwnerAtom,
} from "#src/lib/workflow-save-store";
import { workflowWorkspaceView } from "#src/lib/workflow-route-state";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const emptyCatalog: ExtensionCatalog = {
  events: [],
  actions: [],
  integrations: [],
};

const WORKFLOW_ID = "wf_1";
const EXECUTION_ID = "exec_1";

const served: WorkflowRunRpcFixture = {
  items: [
    {
      id: EXECUTION_ID,
      workflowId: WORKFLOW_ID,
      workflowRunId: "run_1",
      status: "completed",
      startedAt: "2026-03-01T10:00:00.000Z",
      completedAt: "2026-03-01T10:00:30.000Z",
      waitingAt: null,
      cancelledAt: null,
      duration: "30s",
      error: null,
      entityValue: null,
      startEventName: null,
      runMode: "live",
      startSource: "event",
    },
  ],
  supersededCount: 0,
  graphs: {},
  logsSummaryExtras: {},
  logsByExecutionId: {},
  waitsByExecutionId: {},
};

/** The one workflow the strip's publication badge reads. */
function workflowPayload(overrides: {
  publishedVersionId?: string;
  hasUnpublishedChanges: boolean;
  mode: "live" | "test";
}) {
  return {
    id: WORKFLOW_ID,
    name: "Workflow",
    isPaused: false,
    mode: overrides.mode,
    visibility: "private",
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T09:30:00.000Z",
    isOwner: true,
    graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
    hasUnpublishedChanges: overrides.hasUnpublishedChanges,
    // A published workflow always carries both: the id the version is read by
    // and the number every surface names it with.
    ...(overrides.publishedVersionId
      ? {
          publishedVersionId: overrides.publishedVersionId,
          publishedVersion: 1,
        }
      : {}),
  };
}

function stubRpc(payload: ReturnType<typeof workflowPayload>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const procedurePath = extractRpcProcedurePath(rpcUrl(input));
      const requestInput = await parseRpcRequestInput(init);

      if (procedurePath === "workflow/getById") {
        return rpcJsonResponse(payload);
      }

      // The issue count's opener reads the operator's connection list.
      if (procedurePath === "integration/getAll") {
        return rpcJsonResponse([]);
      }

      return answerWorkflowRunRpc(served, procedurePath, requestInput);
    })
  );
}

function renderStrip(
  options: {
    executionId?: string;
    hasUnsavedChanges?: boolean;
    isOwner?: boolean;
    mode?: "live" | "test";
    published?: boolean;
  } = {}
) {
  const store = createStore();
  store.set(isWorkflowOwnerAtom, options.isOwner ?? true);
  store.set(currentWorkflowIdAtom, WORKFLOW_ID);
  store.set(hasUnsavedChangesAtom, options.hasUnsavedChanges ?? false);
  // The route loader's hydrate writes the id and the mode together, so the
  // strip reads mode from the atom and takes the payload's arrival as the
  // signal that a workflow has been loaded into it. The fixture pairs them the
  // same way.
  store.set(currentWorkflowModeAtom, options.mode ?? "live");

  stubRpc(
    workflowPayload({
      hasUnpublishedChanges: true,
      mode: options.mode ?? "live",
      ...(options.published ? { publishedVersionId: "ver_1" } : {}),
    })
  );

  const addEventListener = vi.spyOn(window, "addEventListener");

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: { executionId?: string } & SearchSchemaInput) => ({
      executionId:
        typeof search.executionId === "string" && search.executionId.length > 0
          ? search.executionId
          : undefined,
    }),
    beforeLoad: ({ search }) => {
      const tab = workflowWorkspaceView(search.executionId);
      if (tab !== null) {
        store.set(workflowWorkspaceViewAtom, tab);
      }
    },
    // The editor shell's arrangement, minus the panel: the sync owns URL →
    // overlay, and the strip is the only thing on screen that can undo it.
    component: () => (
      <>
        <ExecutionOverlaySync />
        <WorkflowStatusStrip workflowId={WORKFLOW_ID} />
      </>
    ),
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [
        options.executionId
          ? `/workflows/${WORKFLOW_ID}?executionId=${options.executionId}`
          : `/workflows/${WORKFLOW_ID}`,
      ],
    }),
  });

  const view = render(
    <JotaiProvider store={store}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ExtensionCatalogProvider value={emptyCatalog}>
          <OverlayProvider>
            <RouterProvider router={router} />
          </OverlayProvider>
        </ExtensionCatalogProvider>
      </QueryClientProvider>
    </JotaiProvider>
  );

  return {
    view,
    store,
    router,
    armedUnloadGuard: () =>
      addEventListener.mock.calls.some(([type]) => type === "beforeunload"),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkflowStatusStrip", () => {
  it("identifies Changes and provides a return to Draft before comparison loads", async () => {
    const { view, store } = renderStrip();

    act(() => store.set(workflowWorkspaceViewAtom, "changes"));

    expect(await view.findByText("Changes")).toBeTruthy();
    expect(view.getByText("Editing is off")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Back to draft" }));
    expect(store.get(workflowWorkspaceViewAtom)).toBe("draft");
  });

  it("reports publication and save state in the fixed status row", async () => {
    const { view } = renderStrip({ mode: "test", published: true });

    await waitFor(() => {
      expect(
        view.getByText("Unpublished changes since version 1")
      ).toBeTruthy();
    });
    expect(view.queryByText("Test mode")).toBeNull();
    expect(view.getByText("Saved")).toBeTruthy();
    expect(view.queryByText("Back to draft")).toBeNull();
  });

  it("keeps execution mode out of the status row", () => {
    const { view } = renderStrip({ mode: "test" });

    expect(view.queryByText("Test mode")).toBeNull();
  });

  // Published mode left the toolbar for this row, so it now sits one divider
  // from the badge naming the version it governs.
  it("carries Published mode beside the publication badge", async () => {
    const { view } = renderStrip({ mode: "test", published: true });

    const mode = await view.findByRole("button", {
      name: "Published mode: Test",
    });
    expect(mode.textContent).toContain("Test");
    expect(mode.className).toContain("text-warning");

    const badge = view.getByText("Unpublished changes since version 1");
    expect(
      badge.compareDocumentPosition(mode) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("offers both modes as one clause each", async () => {
    const { view } = renderStrip({ published: true });

    const mode = await view.findByRole("button", {
      name: "Published mode: Live",
    });
    fireEvent.keyDown(mode, { key: "ArrowDown" });
    fireEvent.keyUp(mode, { key: "ArrowDown" });

    const live = view.getByRole("menuitemradio", { name: /Real recipients/ });
    expect(live.getAttribute("aria-checked")).toBe("true");
    expect(
      view.getByRole("menuitemradio", { name: /Test recipients/ })
    ).toBeTruthy();
    // Something is published, so the setting is already in force and says
    // nothing about when it starts to matter.
    expect(view.queryByText("Takes effect on publish")).toBeNull();
  });

  // The mode is set before the first publish too, and the menu is where the
  // reader is told it is waiting for one.
  it("says when the mode starts to matter before the first publish", async () => {
    const { view } = renderStrip();

    const mode = await view.findByRole("button", {
      name: "Published mode: Live",
    });
    fireEvent.keyDown(mode, { key: "ArrowDown" });
    fireEvent.keyUp(mode, { key: "ArrowDown" });

    expect(view.getByText("Takes effect on publish")).toBeTruthy();
  });

  it("refuses the mode to anyone but the owner, and says why", async () => {
    const { view } = renderStrip({ isOwner: false, published: true });

    const mode = await view.findByRole("button", {
      name: "Published mode: Live",
    });
    expect(mode.hasAttribute("disabled")).toBe(true);
    expect(mode.getAttribute("title")).toBe("Owner only");
  });

  it("switches to the run state and offers the way back to the draft", async () => {
    const { view, store, router } = renderStrip({
      executionId: EXECUTION_ID,
    });

    await waitFor(() => {
      expect(view.getByText("v7 · Live run")).toBeTruthy();
    });
    expect(view.getByText("Editing is off")).toBeTruthy();
    expect(store.get(canvasEditingLockedAtom)).toBe(true);

    // #96: no run panel is mounted in this tree at all, which is the state a
    // collapsed rail leaves behind. The strip is the only way out.
    await act(async () => {
      fireEvent.click(view.getByText("Back to draft"));
    });

    await waitFor(() => {
      expect(store.get(canvasEditingLockedAtom)).toBe(false);
    });
    expect(router.state.location.search).toEqual({});
    expect(view.queryByText("v7 · Live run")).toBeNull();
  });

  it("arms the reload guard while a run is pinned over an unsaved draft", async () => {
    // The guard used to live inside the save label, which the run state does
    // not mount: an edit made inside the 1s autosave debounce and followed by a
    // click on a run was dropped on reload with no prompt.
    const { view, armedUnloadGuard } = renderStrip({
      executionId: EXECUTION_ID,
      hasUnsavedChanges: true,
    });

    await waitFor(() => {
      expect(view.getByText("v7 · Live run")).toBeTruthy();
    });

    expect(armedUnloadGuard()).toBe(true);
  });
});
