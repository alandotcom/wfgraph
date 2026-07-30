import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hydrateExtensionsFromApi } from "#src/lib/extensions";
import {
  repairNodeIntegration,
  repairNodeIntegrations,
  requiredIntegrationType,
} from "#src/lib/node-integration";
import type { ExtensionCatalog } from "@rova/shared/extensions/catalog";
import type { WorkflowNode } from "@rova/shared/workflow/types";

/**
 * Which connection an action needs is the catalog's answer, so these cases need
 * one. The two entries are what the assembled surface holds for the engine's own
 * Database Query and Condition: one names a connection, the other needs none.
 */
const served: ExtensionCatalog = {
  events: [],
  actions: [
    {
      id: "Database Query",
      label: "Database Query",
      description: "Query your database",
      category: "System",
      integration: "database",
      configFields: [],
      outputFields: [],
    },
    {
      id: "Condition",
      label: "Condition",
      description: "Branch based on a condition",
      category: "System",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [
    {
      type: "database",
      label: "Database",
      description: "Connect to PostgreSQL databases",
      credentialFields: [],
      hasTest: true,
    },
  ],
};

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ catalog: served }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    )
  );
  await hydrateExtensionsFromApi();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function actionNode(
  config: Record<string, unknown>,
  id = "node_1"
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: "Step", type: "action", config },
  };
}

const dbConnection = { id: "int_db", type: "database" };
const otherDbConnection = { id: "int_db_2", type: "database" };
const slackConnection = { id: "int_slack", type: "slack" };

describe("requiredIntegrationType", () => {
  it("reads the integration a built-in action names", () => {
    expect(requiredIntegrationType("Database Query")).toBe("database");
  });

  it("is undefined for an action that needs no connection", () => {
    expect(requiredIntegrationType("Condition")).toBeUndefined();
  });
});

describe("repairNodeIntegration", () => {
  it("selects the only connection of the right kind", () => {
    const node = actionNode({ actionType: "Database Query" });

    const repaired = repairNodeIntegration(node, [dbConnection]);

    expect(repaired.data.config?.integrationId).toBe("int_db");
  });

  it("clears an id when no connection of that kind is left", () => {
    const node = actionNode({
      actionType: "Database Query",
      integrationId: "int_deleted",
    });

    const repaired = repairNodeIntegration(node, [slackConnection]);

    expect(repaired.data.config?.integrationId).toBeUndefined();
  });

  it("leaves the choice alone when more than one connection would fit", () => {
    const node = actionNode({
      actionType: "Database Query",
      integrationId: "int_deleted",
    });

    const repaired = repairNodeIntegration(node, [
      dbConnection,
      otherDbConnection,
    ]);

    expect(repaired).toBe(node);
  });

  it("returns the same object when the stored id is still valid", () => {
    const node = actionNode({
      actionType: "Database Query",
      integrationId: "int_db",
    });

    // Identity, not just equality: the graph store reads a new node object as
    // an edit and queues an autosave.
    expect(repairNodeIntegration(node, [dbConnection])).toBe(node);
  });

  it("leaves a node with no action type alone", () => {
    const node = actionNode({});

    expect(repairNodeIntegration(node, [dbConnection])).toBe(node);
  });

  it("leaves an action that needs no connection alone", () => {
    const node = actionNode({ actionType: "Condition" });

    expect(repairNodeIntegration(node, [dbConnection])).toBe(node);
  });

  it("does not invent an id for a node that never had one", () => {
    const node = actionNode({ actionType: "Database Query" });

    // No candidates and nothing stored means there is nothing to repair.
    expect(repairNodeIntegration(node, [slackConnection])).toBe(node);
  });
});

describe("repairNodeIntegrations", () => {
  it("returns the same array when every node is already correct", () => {
    const nodes = [
      actionNode({ actionType: "Database Query", integrationId: "int_db" }),
      actionNode({ actionType: "Condition" }, "node_2"),
    ];

    expect(repairNodeIntegrations(nodes, [dbConnection])).toBe(nodes);
  });

  it("repairs only the nodes that need it", () => {
    const healthy = actionNode(
      { actionType: "Database Query", integrationId: "int_db" },
      "node_1"
    );
    const stale = actionNode(
      { actionType: "Database Query", integrationId: "int_gone" },
      "node_2"
    );

    const repaired = repairNodeIntegrations([healthy, stale], [dbConnection]);

    expect(repaired).not.toBe([healthy, stale]);
    expect(repaired[0]).toBe(healthy);
    expect(repaired[1].data.config?.integrationId).toBe("int_db");
  });
});
