import { describe, expect, it } from "vitest";
import {
  repairNodeIntegration,
  repairNodeIntegrations,
  requiredIntegrationType,
} from "#src/lib/node-integration";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

/**
 * Which connection an action needs is the catalog's answer, so these cases need
 * one. The two entries are what the assembled surface holds for a plugin action
 * and for the engine's own Condition: one names a connection, the other needs
 * none.
 */
const served: ExtensionCatalog = {
  events: [
    {
      name: "twilio/message.received",
      label: "Message received",
      integration: "twilio",
      correlationPath: "message.id",
      payloadFields: [{ path: "message.id", type: "string" }],
    },
  ],
  actions: [
    {
      id: "twilio/send-sms",
      label: "Send SMS",
      description: "Send an SMS via Twilio",
      category: "Twilio",
      integration: "twilio",
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
      type: "twilio",
      label: "Twilio",
      description: "Send SMS messages with Twilio",
      credentialFields: {},
      hasTest: true,
      hasWebhook: false,
    },
  ],
};

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

function lifecycleNode(
  lifecycleRules: Record<string, unknown>,
  id = "lifecycle_1"
): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Lifecycle",
      type: "lifecycle",
      config: { lifecycleRules },
    },
  };
}

function waitNode(
  waitFor: Array<Record<string, unknown>>,
  id = "wait_1"
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Wait",
      type: "action",
      config: { actionType: "Wait", waitMode: "event", waitFor },
    },
  };
}

const twilioConnection = { id: "int_twilio", type: "twilio" };
const otherTwilioConnection = { id: "int_twilio_2", type: "twilio" };
const slackConnection = { id: "int_slack", type: "slack" };

describe("requiredIntegrationType", () => {
  it("reads the integration a plugin action names", () => {
    expect(requiredIntegrationType(served, "twilio/send-sms")).toBe("twilio");
  });

  it("is undefined for an action that needs no connection", () => {
    expect(requiredIntegrationType(served, "Condition")).toBeUndefined();
  });
});

describe("repairNodeIntegration", () => {
  it("selects the only connection of the right kind", () => {
    const node = actionNode({ actionType: "twilio/send-sms" });

    const repaired = repairNodeIntegration(served, node, [twilioConnection]);

    expect(repaired.data.config?.integrationId).toBe("int_twilio");
  });

  it("clears an id when no connection of that kind is left", () => {
    const node = actionNode({
      actionType: "twilio/send-sms",
      integrationId: "int_deleted",
    });

    const repaired = repairNodeIntegration(served, node, [slackConnection]);

    expect(repaired.data.config?.integrationId).toBeUndefined();
  });

  it("clears a stale id when more than one connection would fit", () => {
    const node = actionNode({
      actionType: "twilio/send-sms",
      integrationId: "int_deleted",
    });

    const repaired = repairNodeIntegration(served, node, [
      twilioConnection,
      otherTwilioConnection,
    ]);

    expect(repaired.data.config?.integrationId).toBeUndefined();
  });

  it("returns the same object when the stored id is still valid", () => {
    const node = actionNode({
      actionType: "twilio/send-sms",
      integrationId: "int_twilio",
    });

    // Identity, not just equality: the graph store reads a new node object as
    // an edit and queues an autosave.
    expect(repairNodeIntegration(served, node, [twilioConnection])).toBe(node);
  });

  it("clears a stored id that exists for the wrong integration type", () => {
    const node = actionNode({
      actionType: "twilio/send-sms",
      integrationId: "int_slack",
    });

    const repaired = repairNodeIntegration(served, node, [slackConnection]);

    expect(repaired.data.config?.integrationId).toBeUndefined();
  });

  it("leaves a node with no action type alone", () => {
    const node = actionNode({});

    expect(repairNodeIntegration(served, node, [twilioConnection])).toBe(node);
  });

  it("leaves an action that needs no connection alone", () => {
    const node = actionNode({ actionType: "Condition" });

    expect(repairNodeIntegration(served, node, [twilioConnection])).toBe(node);
  });

  it("does not invent an id for a node that never had one", () => {
    const node = actionNode({ actionType: "twilio/send-sms" });

    // No candidates and nothing stored means there is nothing to repair.
    expect(repairNodeIntegration(served, node, [slackConnection])).toBe(node);
  });
});

describe("repairNodeIntegrations", () => {
  it("returns the same array when every node is already correct", () => {
    const nodes = [
      actionNode({
        actionType: "twilio/send-sms",
        integrationId: "int_twilio",
      }),
      actionNode({ actionType: "Condition" }, "node_2"),
    ];

    expect(repairNodeIntegrations(served, nodes, [twilioConnection])).toBe(
      nodes
    );
  });

  it("repairs only the nodes that need it", () => {
    const healthy = actionNode(
      { actionType: "twilio/send-sms", integrationId: "int_twilio" },
      "node_1"
    );
    const stale = actionNode(
      { actionType: "twilio/send-sms", integrationId: "int_gone" },
      "node_2"
    );

    const repaired = repairNodeIntegrations(
      served,
      [healthy, stale],
      [twilioConnection]
    );

    expect(repaired).not.toBe([healthy, stale]);
    expect(repaired[0]).toBe(healthy);
    expect(repaired[1].data.config?.integrationId).toBe("int_twilio");
  });

  it("clears a stale Lifecycle connection id when no matching connection remains", () => {
    const node = lifecycleNode({
      startEvents: ["twilio/message.received"],
      cancelEvents: [],
      concurrency: "unlimited",
      connectionIds: { "twilio/message.received": "int_deleted" },
    });

    const repaired = repairNodeIntegrations(served, [node], [slackConnection]);

    expect(repaired[0].data.config?.lifecycleRules).toEqual({
      startEvents: ["twilio/message.received"],
      cancelEvents: [],
      concurrency: "unlimited",
      connectionIds: undefined,
    });
  });

  it("rebinds a stale Lifecycle connection id to the only matching connection", () => {
    const node = lifecycleNode({
      startEvents: ["twilio/message.received"],
      cancelEvents: [],
      concurrency: "unlimited",
      connectionIds: { "twilio/message.received": "int_deleted" },
    });

    const repaired = repairNodeIntegrations(served, [node], [twilioConnection]);

    expect(repaired[0].data.config?.lifecycleRules).toEqual({
      startEvents: ["twilio/message.received"],
      cancelEvents: [],
      concurrency: "unlimited",
      connectionIds: { "twilio/message.received": "int_twilio" },
    });
  });

  it("clears a Lifecycle connection id that belongs to another integration", () => {
    const node = lifecycleNode({
      startEvents: ["twilio/message.received"],
      cancelEvents: [],
      concurrency: "unlimited",
      connectionIds: { "twilio/message.received": "int_slack" },
    });

    const repaired = repairNodeIntegrations(served, [node], [slackConnection]);

    expect(repaired[0].data.config?.lifecycleRules).toEqual({
      startEvents: ["twilio/message.received"],
      cancelEvents: [],
      concurrency: "unlimited",
      connectionIds: undefined,
    });
  });

  it("uses a valid sibling binding when several connections match the integration", () => {
    const node = lifecycleNode({
      startEvents: ["twilio/message.received", "twilio/message.delivered"],
      cancelEvents: [],
      concurrency: "unlimited",
      connectionIds: {
        "twilio/message.received": "int_twilio",
        "twilio/message.delivered": "int_deleted",
      },
    });
    const catalog: ExtensionCatalog = {
      ...served,
      events: [
        ...served.events,
        {
          name: "twilio/message.delivered",
          label: "Message delivered",
          integration: "twilio",
          payloadFields: [],
        },
      ],
    };

    const repaired = repairNodeIntegrations(
      catalog,
      [node],
      [twilioConnection, otherTwilioConnection]
    );

    expect(repaired[0].data.config?.lifecycleRules).toMatchObject({
      connectionIds: {
        "twilio/message.received": "int_twilio",
        "twilio/message.delivered": "int_twilio",
      },
    });
  });

  it("preserves a connection id while its Event is absent from the catalog", () => {
    const node = lifecycleNode({
      startEvents: ["plugin/event.unavailable"],
      cancelEvents: [],
      concurrency: "unlimited",
      connectionIds: { "plugin/event.unavailable": "int_plugin" },
    });
    const nodes = [node];

    const repaired = repairNodeIntegrations(served, nodes, []);

    expect(repaired).toBe(nodes);
    expect(repaired[0]).toBe(node);
  });

  it("clears stale Wait subscription connection ids when no matching connection remains", () => {
    const node = waitNode([
      { event: "twilio/message.received", connectionId: "int_deleted" },
    ]);

    const repaired = repairNodeIntegrations(served, [node], [slackConnection]);

    expect(repaired[0].data.config?.waitFor).toEqual([
      { event: "twilio/message.received" },
    ]);
  });

  it("rebinds stale Wait subscription connection ids to the only matching connection", () => {
    const node = waitNode([
      { event: "twilio/message.received", connectionId: "int_deleted" },
    ]);

    const repaired = repairNodeIntegrations(served, [node], [twilioConnection]);

    expect(repaired[0].data.config?.waitFor).toEqual([
      { event: "twilio/message.received", connectionId: "int_twilio" },
    ]);
  });

  it("returns the same graph objects when Lifecycle and Wait connections remain valid", () => {
    const lifecycle = lifecycleNode({
      startEvents: ["twilio/message.received"],
      cancelEvents: [],
      concurrency: "unlimited",
      connectionIds: { "twilio/message.received": "int_twilio" },
    });
    const wait = waitNode([
      { event: "twilio/message.received", connectionId: "int_twilio" },
    ]);
    const nodes = [lifecycle, wait];

    const repaired = repairNodeIntegrations(served, nodes, [twilioConnection]);

    expect(repaired).toBe(nodes);
    expect(repaired[0]).toBe(lifecycle);
    expect(repaired[1]).toBe(wait);
  });
});
