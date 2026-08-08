import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import type { JSX } from "react";
import { toast } from "sonner";
import type { NodeConfigPatch } from "#src/components/workflow/config/node-config-patch";
import { useNodeConfigWriter } from "#src/components/workflow/config/use-node-config-writer";
import type { Integration } from "#src/lib/rpc-client";
import * as rpcQuery from "#src/lib/rpc-query";
import {
  clearTestCatalog,
  hydrateTestCatalog,
} from "#src/lib/extensions-test-support";
import {
  extractRpcProcedurePath,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import { isWorkflowOwnerAtom } from "#src/lib/workflow-save-store";
import { propertiesPanelActiveTabAtom } from "#src/lib/workflow-ui-store";
import { type ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

/**
 * The connection a node points at is settled inside `updateConfig`, from the
 * connection list in the query cache. Reading that list at call time rather
 * than from the render the callback was created in is what these pin: creating
 * a connection from a node's own button writes the cache and then calls back
 * through a callback the overlay stack froze at push time.
 *
 * `repairNodeIntegration`'s lookup reads `requiredIntegrationType` off the
 * catalog module, so these cases put a real one rather than leaving it at
 * `emptyExtensionCatalog`: an empty catalog answers every action type with no
 * required integration, and the repair below would no-op regardless of which
 * case ran.
 *
 * Router is a real provider, and deleteExecutions is stubbed through fetch rather
 * than `vi.mock`, so isolate:false does not leave this file's replacements on
 * the shared registry for neighbours.
 */

const CONNECTED_ACTION = "twilio/send-sms";

const served: ExtensionCatalog = {
  events: [],
  actions: [
    {
      id: CONNECTED_ACTION,
      label: "Send SMS",
      description: "Send an SMS via Twilio",
      category: "Twilio",
      integration: "twilio",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [
    {
      type: "twilio",
      label: "Twilio",
      description: "Send SMS messages with Twilio",
      credentialFields: {},
      hasTest: true,
    },
  ],
};

beforeEach(async () => {
  await hydrateTestCatalog(served);
  vi.spyOn(toast, "success").mockImplementation(() => "id" as never);
});

afterEach(async () => {
  await clearTestCatalog();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function integration(id: string): Integration {
  return {
    id,
    name: id,
    type: "twilio",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function connectedNode(config: Record<string, unknown>): WorkflowNode {
  return {
    id: "node_1",
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: "Send SMS", type: "action", config },
  };
}

function renderInWorkflowRoute(
  store: ReturnType<typeof createStore>,
  queryClient: QueryClient,
  Component: () => JSX.Element,
  initialEntry = "/workflows/wf_1"
) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: Record<string, unknown>) => ({
      executionId:
        typeof search.executionId === "string" ? search.executionId : undefined,
    }),
    component: Component,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [initialEntry],
    }),
  });

  render(
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={store}>
        <RouterProvider router={router} />
      </JotaiProvider>
    </QueryClientProvider>
  );

  return router;
}

/**
 * A panel that writes one patch when clicked. No workflow id is set, so the
 * write reaches the graph store and stops there instead of queueing a save.
 */
function renderWriter(
  node: WorkflowNode,
  patch: NodeConfigPatch,
  /** The connections the cache holds before anything renders. */
  connections?: string[]
) {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, { nodes: [node], edges: [] });
  store.set(selectedNodeAtom, node.id);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (connections) {
    setConnections(queryClient, connections);
  }

  function Writer() {
    const { updateConfig } = useNodeConfigWriter();
    return (
      <button onClick={() => updateConfig(patch)} type="button">
        write
      </button>
    );
  }

  renderInWorkflowRoute(store, queryClient, Writer);

  return {
    queryClient,
    write: async () => {
      fireEvent.click(await screen.findByRole("button", { name: "write" }));
    },
    config: () => store.get(nodesAtom)[0]?.data.config,
  };
}

function setConnections(queryClient: QueryClient, ids: string[]) {
  queryClient.setQueryData(
    rpcQuery.integrationsQueryOptions().queryKey,
    ids.map(integration)
  );
}

describe("updateConfig and the connection a node points at", () => {
  it("keeps a connection that was created after this render", async () => {
    const { queryClient, write, config } = renderWriter(
      connectedNode({ actionType: CONNECTED_ACTION }),
      { integrationId: "int_new" },
      ["int_old"]
    );

    // What creating a connection from the node's own button does: the write
    // refreshes the list, then the frozen callback selects the new id. A list
    // read at render time is still the one-connection list above, and the
    // repair would rebind the node to it.
    setConnections(queryClient, ["int_old", "int_new"]);
    await write();

    expect(config()?.integrationId).toBe("int_new");
  });

  it("leaves the node alone while the connection list has never been fetched", async () => {
    const { write, config } = renderWriter(
      connectedNode({
        actionType: CONNECTED_ACTION,
        integrationId: "int_gone",
      }),
      { smsTo: "+15550001111" }
    );

    await write();

    // An unfetched entry is not an empty connection list, and clearing the id
    // here would report a healthy node as needing a connection.
    expect(config()?.integrationId).toBe("int_gone");
  });

  it("drops the connection when the action changes", async () => {
    const { write, config } = renderWriter(
      connectedNode({
        actionType: CONNECTED_ACTION,
        integrationId: "int_twilio",
      }),
      { actionType: "Condition" },
      ["int_twilio"]
    );

    await write();

    expect(config()?.integrationId).toBeUndefined();
  });
});

describe("deleteRuns", () => {
  it("clears the open run via the URL on success", async () => {
    const store = createStore();
    store.set(loadWorkflowGraphAtom, {
      nodes: [connectedNode({ actionType: CONNECTED_ACTION })],
      edges: [],
    });
    store.set(isWorkflowOwnerAtom, true);
    store.set(propertiesPanelActiveTabAtom, "runs");

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = rpcUrl(input);
        const procedurePath = extractRpcProcedurePath(url);
        if (procedurePath === "workflow/deleteExecutions") {
          return rpcJsonResponse({});
        }
        throw new Error(`unexpected fetch in deleteRuns test: ${url}`);
      })
    );

    const refreshSpy = vi
      .spyOn(rpcQuery, "refreshRunHistory")
      .mockResolvedValue(undefined as never);

    function Deleter() {
      const { deleteRuns } = useNodeConfigWriter();
      return (
        <button
          onClick={() => deleteRuns.mutate({ workflowId: "wf_1" })}
          type="button"
        >
          delete
        </button>
      );
    }

    const router = renderInWorkflowRoute(
      store,
      queryClient,
      Deleter,
      "/workflows/wf_1?executionId=exec_1"
    );

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "delete" }));
    });

    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
    expect(refreshSpy).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("All runs deleted");
  });
});
