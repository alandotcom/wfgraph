import { QueryClientProvider } from "@tanstack/react-query";
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
import { ReactFlowProvider } from "@xyflow/react";
import { Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayContainer } from "#src/components/overlays/overlay-container";
import {
  OverlayProvider,
  useOverlay,
} from "#src/components/overlays/overlay-provider";
import {
  WorkflowIssuesOverlay,
  type WorkflowIssuesOverlayInput,
} from "#src/components/overlays/workflow-issues-overlay";
import { DetailsPanel } from "#src/components/workflow/details/details-panel";
import { WorkflowCanvas } from "#src/components/workflow/workflow-canvas";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import { useGoToStep } from "#src/hooks/use-workflow-issues";
import { appStore } from "#src/lib/app-store";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { queryClient } from "#src/lib/query-client";
import {
  extractRpcProcedurePath,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import { router as appRouter } from "#src/router";
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";

/**
 * An issue's Edit selects its step and then asks the router for Draft. These
 * cases run the editor route's own loader, because the router runs it again
 * for a navigation to the address it already shows, and the hydration that
 * loader performs clears the Draft selection.
 */

const WORKFLOW_ID = "workflow_1";

const CATALOG: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [],
  actions: [
    {
      id: "mailer/send",
      label: "Send email",
      description: "Send an email",
      category: "Mail",
      configFields: [],
      outputFields: [],
    },
  ],
};

const NODES: WorkflowNode[] = [
  {
    id: "life",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Patient became inactive", type: "lifecycle" },
  },
  {
    id: "qualify",
    type: "action",
    position: { x: 0, y: 180 },
    data: {
      label: "Qualification",
      type: "action",
      config: { actionType: "mailer/send" },
    },
  },
];

const WORKFLOW = {
  id: WORKFLOW_ID,
  name: "Patient reactivation",
  isPaused: false,
  mode: "live" as const,
  visibility: "private" as const,
  createdAt: "2026-09-04T09:00:00.000Z",
  updatedAt: "2026-09-04T09:00:00.000Z",
  graph: createSerializedWorkflowGraph({
    nodes: NODES,
    edges: [
      {
        id: "life-qualify",
        source: "life",
        target: "qualify",
        sourceHandle: "started",
      },
    ],
  }),
  draftRevision: 1,
  hasUnpublishedChanges: false,
};

/** The issues list a blocked Publish opens, naming one missing field. */
function openBlockedPublishIssues(
  push: ReturnType<typeof useOverlay>["push"],
  goToStep: (nodeId: string, fieldKey?: string) => void
) {
  push<WorkflowIssuesOverlayInput>(WorkflowIssuesOverlay, {
    trigger: "publish",
    onGoToStep: goToStep,
    issues: {
      totalIssues: 1,
      draftRunBlockingCount: 1,
      publishBlockingCount: 1,
      invalidGroups: [],
      invalidLifecycleRules: [],
      missingIntegrations: [],
      brokenReferences: [],
      missingRequiredFields: [
        {
          nodeId: "qualify",
          nodeLabel: "Qualification",
          missingFields: [{ fieldKey: "to", fieldLabel: "To" }],
        },
      ],
      unverifiedProviderFields: [],
      sharedConditionPaths: [],
    },
  });
}

function Probe() {
  const goToStep = useGoToStep();
  const { push } = useOverlay();
  return (
    <>
      <button onClick={() => goToStep("qualify")} type="button">
        Edit issue in details
      </button>
      <button
        onClick={() => openBlockedPublishIssues(push, goToStep)}
        type="button"
      >
        Open blocked Publish issues
      </button>
    </>
  );
}

async function renderEditorRoute(initialSearch: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: WorkflowRouteSearch & SearchSchemaInput) =>
      authorizedWorkflowSearch(search, { canOpenRuns: true, canReview: true }),
    component: () => (
      <div style={{ width: 1400, height: 900 }}>
        <WorkspaceRouteSync />
        <WorkflowCanvas />
        <DetailsPanel />
        <Probe />
      </div>
    ),
  });
  // The application's own loader, whose declared type is tied to the
  // application's route and cannot be named for this one.
  Reflect.set(
    workflowRoute.options,
    "loader",
    appRouter.routesById["/workflows/$workflowId"].options.loader
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [`/workflows/${WORKFLOW_ID}${initialSearch}`],
    }),
  });

  const view = render(
    <ExtensionCatalogProvider value={CATALOG}>
      <IntegrationUiProvider value={{}}>
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={appStore}>
            <ReactFlowProvider>
              <OverlayProvider>
                <RouterProvider router={router} />
                <OverlayContainer />
              </OverlayProvider>
            </ReactFlowProvider>
          </JotaiProvider>
        </QueryClientProvider>
      </IntegrationUiProvider>
    </ExtensionCatalogProvider>
  );
  await view.findByRole("button", { name: "Edit issue in details" });
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-id="qualify"].react-flow__node')
    ).not.toBeNull()
  );
  return { view, search: () => router.state.location.search };
}

/**
 * Long enough for a navigation's loader to answer and hydrate the store, and
 * for the route sync to run after it.
 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

beforeEach(() => {
  installAuthorizationGrantsForTests(WfGraphOperationIds);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = extractRpcProcedurePath(rpcUrl(input));
      if (path === "workflow/getById") {
        return rpcJsonResponse(WORKFLOW);
      }
      if (path === "integration/getAll") {
        return rpcJsonResponse([]);
      }
      return new Response("{}", { status: 404 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthorizationGrantsForTests();
  queryClient.clear();
});

describe("an issue's Edit on the editor route", () => {
  it("keeps the step it selects from the Inspector in Draft", async () => {
    const { view, search } = await renderEditorRoute("");
    // The router counts a loader's data stale only after time has passed.
    await settle();

    fireEvent.click(
      view.getByRole("button", { name: "Edit issue in details" })
    );
    await settle();

    expect(search()).toEqual({});
    expect(appStore.get(activeSelectionAtom).nodeIds).toEqual(["qualify"]);
  });

  it("keeps the step it selects from the issues list a blocked Publish opens", async () => {
    const { view } = await renderEditorRoute("");
    await settle();

    fireEvent.click(
      view.getByRole("button", { name: "Open blocked Publish issues" })
    );
    fireEvent.click(
      await view.findByRole("button", { name: "Edit To in Qualification" })
    );
    await settle();

    expect(appStore.get(activeSelectionAtom).nodeIds).toEqual(["qualify"]);
    await waitFor(() =>
      expect(
        view.queryByRole("button", { name: "Edit To in Qualification" })
      ).toBeNull()
    );
  });

  it("keeps the step it selects from Runs, in the Draft it switches to", async () => {
    const { view, search } = await renderEditorRoute("?view=runs");
    await settle();

    fireEvent.click(
      view.getByRole("button", { name: "Edit issue in details" })
    );
    await waitFor(() => expect(search()).toEqual({}));
    await settle();

    expect(appStore.get(activeSelectionAtom).nodeIds).toEqual(["qualify"]);
  });
});
