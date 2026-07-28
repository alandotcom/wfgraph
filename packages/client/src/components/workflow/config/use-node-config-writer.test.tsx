import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import type { NodeConfigPatch } from "@/components/workflow/config/node-config-patch";
import { useNodeConfigWriter } from "@/components/workflow/config/use-node-config-writer";
import type { Integration } from "@/lib/rpc-client";
import { integrationsQueryOptions } from "@/lib/rpc-query";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
  selectedNodeAtom,
} from "@/lib/workflow-graph-store";
import type { WorkflowNode } from "@rova/shared/workflow/types";

/**
 * The connection a node points at is settled inside `updateConfig`, from the
 * connection list in the query cache. Reading that list at call time rather
 * than from the render the callback was created in is what these pin: creating
 * a connection from a node's own button writes the cache and then calls back
 * through a callback the overlay stack froze at push time.
 */

const DATABASE_ACTION = "Database Query";

function integration(id: string): Integration {
  return {
    id,
    name: id,
    type: "database",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function databaseNode(config: Record<string, unknown>): WorkflowNode {
  return {
    id: "node_1",
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: "Query", type: "action", config },
  };
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

  const view = render(
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={store}>
        <Writer />
      </JotaiProvider>
    </QueryClientProvider>
  );

  return {
    queryClient,
    write: () => fireEvent.click(view.getByText("write")),
    config: () => store.get(nodesAtom)[0]?.data.config,
  };
}

function setConnections(queryClient: QueryClient, ids: string[]) {
  queryClient.setQueryData(
    integrationsQueryOptions().queryKey,
    ids.map(integration)
  );
}

describe("updateConfig and the connection a node points at", () => {
  it("keeps a connection that was created after this render", () => {
    const { queryClient, write, config } = renderWriter(
      databaseNode({ actionType: DATABASE_ACTION }),
      { integrationId: "int_new" },
      ["int_old"]
    );

    // What creating a connection from the node's own button does: the write
    // refreshes the list, then the frozen callback selects the new id. A list
    // read at render time is still the one-connection list above, and the
    // repair would rebind the node to it.
    setConnections(queryClient, ["int_old", "int_new"]);
    write();

    expect(config()?.integrationId).toBe("int_new");
  });

  it("leaves the node alone while the connection list has never been fetched", () => {
    const { write, config } = renderWriter(
      databaseNode({ actionType: DATABASE_ACTION, integrationId: "int_gone" }),
      { query: "select 1" }
    );

    write();

    // An unfetched entry is not an empty connection list, and clearing the id
    // here would report a healthy node as needing a connection.
    expect(config()?.integrationId).toBe("int_gone");
  });

  it("drops the connection when the action changes", () => {
    const { write, config } = renderWriter(
      databaseNode({ actionType: DATABASE_ACTION, integrationId: "int_db" }),
      { actionType: "Condition" },
      ["int_db"]
    );

    write();

    expect(config()?.integrationId).toBeUndefined();
  });
});
