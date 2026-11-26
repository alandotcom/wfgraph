/**
 * The strip's two states, and the two things it is the only surface for: the
 * way out of a pinned run with no panel on screen (#96), and the unload guard
 * that used to unmount with the draft state.
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
import {
  canvasEditingLockedAtom,
  recordObservedRemoteDraftRevisionAtom,
} from "#src/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
  hasUnsavedChangesAtom,
  lastSaveErrorAtom,
} from "#src/lib/workflow-save-store";
import { ApiError } from "#src/lib/rpc-client";
import { DRAFT_CONFLICT_CODE } from "@wfgraph/shared/rpc/error-codes";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  WfGraphOperationIds,
  WfGraphOperations,
} from "@wfgraph/shared/authorization/operations";

const emptyCatalog: ExtensionCatalog = {
  entities: [],
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
  publishedVersionId?: string | undefined;
  hasUnpublishedChanges: boolean;
  mode: "live" | "test";
  isPaused?: boolean;
}) {
  return {
    id: WORKFLOW_ID,
    name: "Workflow",
    isPaused: overrides.isPaused ?? false,
    mode: overrides.mode,
    visibility: "private",
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T09:30:00.000Z",
    graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
    hasUnpublishedChanges: overrides.hasUnpublishedChanges,
    // A published workflow carries both the id the version is read by and the
    // number every surface displays.
    publishedVersionId: overrides.publishedVersionId,
    publishedVersion: overrides.publishedVersionId ? 1 : undefined,
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

async function renderStrip(
  options: {
    executionId?: string;
    hasUnsavedChanges?: boolean;
    canUpdate?: boolean;
    mode?: "live" | "test";
    published?: boolean;
    paused?: boolean;
  } = {}
) {
  const store = createStore();
  store.set(currentWorkflowIdAtom, WORKFLOW_ID);
  store.set(hasUnsavedChangesAtom, options.hasUnsavedChanges ?? false);
  // The route loader's hydrate writes the id and the mode together, so the
  // strip reads mode from the atom and takes the payload's arrival as the
  // signal that a workflow has been loaded into it. The fixture pairs them the
  // same way.
  store.set(currentWorkflowModeAtom, options.mode ?? "live");
  installAuthorizationGrantsForTests(
    (options.canUpdate ?? true)
      ? WfGraphOperationIds
      : WfGraphOperationIds.filter(
          (operationId) => operationId !== WfGraphOperations.workflowUpdate.id
        )
  );

  stubRpc(
    workflowPayload({
      hasUnpublishedChanges: true,
      mode: options.mode ?? "live",
      publishedVersionId: options.published ? "ver_1" : undefined,
      isPaused: options.paused ?? false,
    })
  );

  const addEventListener = vi.spyOn(window, "addEventListener");

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: WorkflowRouteSearch & SearchSchemaInput) =>
      authorizedWorkflowSearch(search, {
        canOpenRuns: true,
        canReview: true,
      }),
    // The editor shell's arrangement, minus the panel: the syncs own route →
    // overlay, and the strip is the only thing on screen that can undo it.
    component: () => (
      <>
        <ExecutionOverlaySync />
        <WorkspaceRouteSync />
        <WorkflowStatusStrip workflowId={WORKFLOW_ID} />
      </>
    ),
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [
        options.executionId
          ? `/workflows/${WORKFLOW_ID}?view=runs&executionId=${options.executionId}`
          : `/workflows/${WORKFLOW_ID}`,
      ],
    }),
  });

  // The router resolves the first match in a microtask. Mounting is
  // therefore an update act has to cover. Without this, a case that asserts
  // before its first `await` reports the match as an update outside act.
  const view = await act(async () =>
    render(
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
    )
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
  resetAuthorizationGrantsForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkflowStatusStrip", () => {
  // The publication state is the chip beside the workflow's name, so the
  // strip says only whether the draft is saved, and how many issues it has.
  it("says whether the draft is saved and nothing about publication", async () => {
    const { view } = await renderStrip({
      mode: "test",
      published: true,
      paused: true,
    });

    await waitFor(() => expect(view.getByText("Saved")).toBeTruthy());
    expect(
      view.queryByText(/Unpublished changes|Published|Never published/)
    ).toBeNull();
    expect(view.queryByRole("button", { name: /Published mode/ })).toBeNull();
    expect(view.queryByText("Paused")).toBeNull();
    expect(view.queryByText("Back to draft")).toBeNull();
  });

  it("offers to reload when a newer persisted draft conflicts with local work", async () => {
    const { view, store } = await renderStrip({ hasUnsavedChanges: true });

    act(() =>
      store.set(recordObservedRemoteDraftRevisionAtom, {
        workflowId: WORKFLOW_ID,
        draftRevision: 2,
      })
    );

    expect(view.getByText("Draft changed elsewhere")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Reload agent edits" })
    ).toBeTruthy();
  });

  // The draft stream is how a tab normally learns of a newer draft. A tab the
  // stream has not reached learns of it when its own save is refused, and the
  // strip offers the same way out for as long as that refusal stands.
  it("offers to reload when the server refused a save because the draft changed", async () => {
    const { view, store } = await renderStrip();
    expect(view.queryByText("Draft changed elsewhere")).toBeNull();

    act(() =>
      store.set(
        lastSaveErrorAtom,
        new ApiError(
          409,
          "The workflow draft changed. Reload it before saving again.",
          DRAFT_CONFLICT_CODE
        )
      )
    );

    expect(view.getByText("Draft changed elsewhere")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Reload agent edits" })
    ).toBeTruthy();

    act(() => store.set(lastSaveErrorAtom, new Error("The network dropped")));
    expect(view.queryByText("Draft changed elsewhere")).toBeNull();
  });

  it("switches to the run state and offers the way back to the draft", async () => {
    const { view, store, router } = await renderStrip({
      executionId: EXECUTION_ID,
    });

    await waitFor(() => {
      expect(view.getByText("v7 · Live run")).toBeTruthy();
    });
    expect(view.getByText("Editing is off")).toBeTruthy();
    expect(store.get(canvasEditingLockedAtom)).toBe(true);

    // #96: no Runs view is mounted in this tree at all, so the strip is the
    // only way out.
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
    const { view, armedUnloadGuard } = await renderStrip({
      executionId: EXECUTION_ID,
      hasUnsavedChanges: true,
    });

    await waitFor(() => {
      expect(view.getByText("v7 · Live run")).toBeTruthy();
    });

    expect(armedUnloadGuard()).toBe(true);
  });
});
