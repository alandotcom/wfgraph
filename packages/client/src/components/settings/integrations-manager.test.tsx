import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayContainer } from "#src/components/overlays/overlay-container";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { IntegrationsManager } from "#src/components/settings/integrations-manager";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";

const ACTION = "linear/find-issues";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  actions: [
    {
      id: ACTION,
      label: "Find Issues",
      description: "Find issues matching a filter",
      category: "Linear",
      integration: "linear",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [
    {
      type: "linear",
      label: "Linear",
      description: "Linear issue tracking",
      credentialFields: {},
      hasTest: true,
      hasWebhook: false,
    },
  ],
};

const connection: Integration = {
  id: "int_linear",
  name: "Linear Testing",
  type: "linear",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  configuredKeys: [],
  connectionDefaults: {},
};

/** A step already pointing at the connection the case goes on to delete. */
const boundNode: WorkflowNode = {
  id: "node_1",
  type: "action",
  position: { x: 0, y: 0 },
  data: {
    label: "Find the issue",
    type: "action",
    config: { actionType: ACTION, integrationId: "int_linear" },
  },
};

afterEach(() => {
  resetAuthorizationGrantsForTests();
  vi.unstubAllGlobals();
});

describe("IntegrationsManager", () => {
  it("leaves a step on its deleted connection rather than moving it to another", async () => {
    // Settings deletes a connection and then reconciles the open graph. A step
    // bound to the deleted connection keeps that id, so it says the connection
    // was deleted, even when exactly one other connection of the kind is left.
    const store = createStore();
    store.set(loadWorkflowGraphAtom, { nodes: [boundNode], edges: [] });

    const otherConnection: Integration = {
      ...connection,
      id: "int_linear_other",
      name: "Acme Linear",
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(integrationsQueryOptions().queryKey, [
      connection,
      otherConnection,
    ]);
    installAuthorizationGrantsForTests(WfGraphOperationIds);

    // The delete lands, and every read of the list after it holds the other
    // connection alone.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/rpc/integration/getAll")) {
          return new Response(JSON.stringify({ json: [otherConnection] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ json: { success: true } }), {
          headers: { "content-type": "application/json" },
        });
      })
    );

    render(
      <ExtensionCatalogProvider value={catalog}>
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={store}>
            <IntegrationUiProvider value={{}}>
              <OverlayProvider>
                <IntegrationsManager />
                <OverlayContainer />
              </OverlayProvider>
            </IntegrationUiProvider>
          </JotaiProvider>
        </QueryClientProvider>
      </ExtensionCatalogProvider>
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Delete Linear Testing/ })
    );

    const confirm = await screen.findByRole("button", { name: "Delete" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() => {
      expect(
        queryClient
          .getQueryData(integrationsQueryOptions().queryKey)
          ?.map((entry) => entry.id)
      ).toEqual(["int_linear_other"]);
    });
    // Let the reconciliation that follows the refreshed list finish.
    await act(async () => {});

    expect(store.get(nodesAtom)[0]?.data.config?.integrationId).toBe(
      "int_linear"
    );
  });

  it("orders two connections that share a label by connection name", async () => {
    // Both connections resolve to the catalog's one "Linear" label, so only
    // the connection name can order them.
    const store = createStore();
    store.set(loadWorkflowGraphAtom, { nodes: [], edges: [] });

    const zConnection: Integration = {
      id: "int_linear_z",
      name: "Z Connection",
      type: "linear",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      configuredKeys: [],
      connectionDefaults: {},
    };
    const aConnection: Integration = {
      id: "int_linear_a",
      name: "A Connection",
      type: "linear",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      configuredKeys: [],
      connectionDefaults: {},
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Seeded in reverse of the expected order, so the assertion fails if the
    // component echoes the fetch order instead of sorting.
    queryClient.setQueryData(integrationsQueryOptions().queryKey, [
      zConnection,
      aConnection,
    ]);
    installAuthorizationGrantsForTests(WfGraphOperationIds);

    render(
      <ExtensionCatalogProvider value={catalog}>
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={store}>
            <IntegrationUiProvider value={{}}>
              <OverlayProvider>
                <IntegrationsManager />
                <OverlayContainer />
              </OverlayProvider>
            </IntegrationUiProvider>
          </JotaiProvider>
        </QueryClientProvider>
      </ExtensionCatalogProvider>
    );

    const a = await screen.findByText("A Connection");
    const z = await screen.findByText("Z Connection");

    expect(
      a.compareDocumentPosition(z) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("shows a failed Test under the row it was pressed on", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(integrationsQueryOptions().queryKey, [connection]);
    installAuthorizationGrantsForTests(WfGraphOperationIds);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/api/rpc/integration/getAll")
          ? new Response(JSON.stringify({ json: [connection] }), {
              headers: { "content-type": "application/json" },
            })
          : new Response(
              JSON.stringify({
                json: {
                  status: "error",
                  message: "Invalid API key. Please check your Linear API key.",
                },
              }),
              { headers: { "content-type": "application/json" } }
            )
      )
    );

    render(
      <ExtensionCatalogProvider value={catalog}>
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={createStore()}>
            <IntegrationUiProvider value={{}}>
              <OverlayProvider>
                <IntegrationsManager />
              </OverlayProvider>
            </IntegrationUiProvider>
          </JotaiProvider>
        </QueryClientProvider>
      </ExtensionCatalogProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Linear rejected the credentials of the Connection Linear Testing. Enter new credentials and test again."
    );
  });
});
