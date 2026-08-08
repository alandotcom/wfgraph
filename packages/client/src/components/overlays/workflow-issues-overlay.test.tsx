import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
  repairIntegrationsAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

/**
 * The issues dialog's Add button creates a connection and then repairs the
 * open graph against the refreshed list. The repair itself is this atom; the
 * overlay only calls it. What used to be covered by mocking the credential form
 * is the write that points unbound nodes at the new connection.
 */

const ACTION = "acuity/list-appointments";

const acuityCatalog = {
  events: [],
  actions: [
    {
      id: ACTION,
      label: "List Appointments",
      description: "List appointments with optional filters",
      category: "Acuity",
      integration: "acuity",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [
    {
      type: "acuity",
      label: "Acuity",
      description: "Acuity Scheduling",
      credentialFields: {},
      hasTest: true,
    },
  ],
};

const unboundNode: WorkflowNode = {
  id: "node_1",
  type: "action",
  position: { x: 0, y: 0 },
  data: {
    label: "Did they reschedule?",
    type: "action",
    config: { actionType: ACTION },
  },
};

describe("repairIntegrationsAtom", () => {
  it("binds flagged nodes to a connection that now exists", () => {
    const store = createStore();
    store.set(loadWorkflowGraphAtom, { nodes: [unboundNode], edges: [] });

    store.set(repairIntegrationsAtom, {
      integrations: [{ id: "int_acuity", type: "acuity" }],
      catalog: acuityCatalog,
    });

    expect(store.get(nodesAtom)[0]?.data.config?.integrationId).toBe(
      "int_acuity"
    );
  });
});
