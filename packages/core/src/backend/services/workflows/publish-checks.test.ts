import { describe, expect, it } from "vitest";
import {
  checkUnreachableSubtrees,
  reachableNodeIds,
} from "#src/backend/services/workflows/publish-checks";
import {
  catalogFingerprint,
  draftDiffersFromPublished,
  graphDigest,
} from "#src/backend/services/workflows/version-digest";
import type {
  ActionMetadata,
  EventMetadata,
  ExtensionCatalog,
  IntegrationMetadata,
} from "@wfgraph/shared/extensions/catalog";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { ActionConfigField } from "@wfgraph/shared/plugins/action-fields";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import { LIFECYCLE_CANCELED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";

function lifecycleNode(cancelEvents: string[] = []) {
  return {
    id: "lifecycle-1",
    type: "lifecycle" as const,
    position: { x: 0, y: 0 },
    data: {
      label: "Start",
      type: "lifecycle" as const,
      config: {
        lifecycleRules: {
          startEvents: ["app/appointment.created"],
          cancelEvents,
          concurrency: "unlimited" as const,
        },
      },
    },
  };
}

function actionNode(id: string, label: string) {
  return {
    id,
    type: "action" as const,
    position: { x: 0, y: 100 },
    data: {
      label,
      type: "action" as const,
      config: { actionType: "Wait" },
    },
  };
}

const lifecycle = lifecycleNode();

const aField = (key: string): ActionConfigField => ({
  key,
  label: key,
  type: "text",
});

const anAction = (id: string): ActionMetadata => ({
  id,
  label: id,
  description: "",
  category: "Test",
  configFields: [aField("to")],
  outputFields: [{ path: "messageId" }],
});

const anEvent = (name: string): EventMetadata => ({
  name,
  label: name,
  payloadFields: [{ path: "id" }],
});

const anIntegration = (type: string): IntegrationMetadata => ({
  type,
  label: type,
  description: "",
  credentialFields: { apiKey: { label: "API key", type: "password" } },
  hasTest: false,
});

const catalogOf = (parts: Partial<ExtensionCatalog>): ExtensionCatalog => ({
  ...emptyExtensionCatalog,
  ...parts,
});

describe("publish-checks", () => {
  it("flags nodes the Lifecycle Node cannot reach", () => {
    const orphan = actionNode("orphan", "Orphan");
    const { nodes, edges } = toWorkflowGraphData(
      createSerializedWorkflowGraph({
        nodes: [lifecycle, orphan],
        edges: [],
      })
    );

    expect(reachableNodeIds({ nodes, edges }).has("orphan")).toBe(false);
    expect(checkUnreachableSubtrees({ nodes, edges })).toEqual({
      valid: false,
      error: expect.stringContaining("Unreachable"),
    });
  });

  // Drawable and muted when no Cancel Event; publish allows, engine does not schedule.
  it("keeps an inactive Canceled branch out of engine reachability", () => {
    const onCancel = actionNode("on-cancel", "Cleanup");
    const { nodes, edges } = toWorkflowGraphData(
      createSerializedWorkflowGraph({
        nodes: [lifecycle, onCancel],
        edges: [
          {
            id: "e1",
            source: lifecycle.id,
            target: onCancel.id,
            sourceHandle: LIFECYCLE_CANCELED_HANDLE,
          },
        ],
      })
    );

    expect(reachableNodeIds({ nodes, edges }).has("on-cancel")).toBe(false);
    expect(checkUnreachableSubtrees({ nodes, edges })).toEqual({
      valid: true,
    });
  });

  it("counts the Canceled branch as reachable when a Cancel Event is declared", () => {
    const entry = lifecycleNode(["app/appointment.canceled"]);
    const onCancel = actionNode("on-cancel", "Cleanup");
    const { nodes, edges } = toWorkflowGraphData(
      createSerializedWorkflowGraph({
        nodes: [entry, onCancel],
        edges: [
          {
            id: "e1",
            source: entry.id,
            target: onCancel.id,
            sourceHandle: LIFECYCLE_CANCELED_HANDLE,
          },
        ],
      })
    );

    expect(reachableNodeIds({ nodes, edges }).has("on-cancel")).toBe(true);
    expect(checkUnreachableSubtrees({ nodes, edges })).toEqual({
      valid: true,
    });
  });

  it("does not treat a Group frame as an unreachable subtree", () => {
    const lookup = actionNode("lookup", "Get User");
    const frame = {
      id: "group-1",
      type: "group" as const,
      position: { x: 0, y: 0 },
      data: {
        label: "Lookups",
        type: "group" as const,
        config: { entryNodeIds: [lookup.id], exitNodeIds: [lookup.id] },
      },
    };
    const { nodes, edges } = toWorkflowGraphData(
      createSerializedWorkflowGraph({
        nodes: [lifecycle, lookup, frame],
        edges: [
          {
            id: "e1",
            source: lifecycle.id,
            target: lookup.id,
            sourceHandle: "started",
          },
        ],
      })
    );

    expect(checkUnreachableSubtrees({ nodes, edges })).toEqual({
      valid: true,
    });
  });
});

describe("version-digest", () => {
  it("hashes the same graph to the same digest", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [lifecycle],
      edges: [],
    });
    expect(graphDigest(graph)).toBe(graphDigest(graph));
  });

  it("ignores editor geometry when comparing a draft with its publication", () => {
    const published = createSerializedWorkflowGraph({
      nodes: [lifecycle],
      edges: [],
    });
    const moved = createSerializedWorkflowGraph({
      nodes: [{ ...lifecycle, position: { x: 40, y: 0 } }],
      edges: [],
    });

    expect(draftDiffersFromPublished(published, published)).toBe(false);
    expect(draftDiffersFromPublished(moved, published)).toBe(false);
    expect(draftDiffersFromPublished(moved, null)).toBe(false);
  });

  it("hashes semantic graphs independently of node, edge, and object order", () => {
    const action = actionNode("action-1", "Send");
    const first = createSerializedWorkflowGraph({
      nodes: [
        lifecycle,
        {
          ...action,
          data: {
            ...action.data,
            config: { actionType: "Wait", options: { first: 1, second: 2 } },
          },
        },
      ],
      edges: [{ id: "edge-1", source: "lifecycle-1", target: "action-1" }],
    });
    const reordered = createSerializedWorkflowGraph({
      nodes: [
        {
          ...action,
          data: {
            ...action.data,
            config: { options: { second: 2, first: 1 }, actionType: "Wait" },
          },
        },
        lifecycle,
      ],
      edges: [
        { id: "edge-recreated", source: "lifecycle-1", target: "action-1" },
      ],
    });

    expect(graphDigest(first)).toBe(graphDigest(reordered));
  });

  it("normalizes null edge handles and empty edge data", () => {
    const nodes = [lifecycle, actionNode("action-1", "Send")];
    const nullish = createSerializedWorkflowGraph({
      nodes,
      edges: [
        {
          id: "edge-1",
          source: "lifecycle-1",
          target: "action-1",
          sourceHandle: null,
          targetHandle: null,
          data: {},
        },
      ],
    });
    const omitted = createSerializedWorkflowGraph({
      nodes,
      edges: [{ id: "edge-2", source: "lifecycle-1", target: "action-1" }],
    });

    expect(graphDigest(nullish)).toBe(graphDigest(omitted));
    expect(draftDiffersFromPublished(omitted, nullish)).toBe(false);
  });

  it("treats a stored enabled: true as the default on state", () => {
    const omitted = createSerializedWorkflowGraph({
      nodes: [actionNode("action-1", "Send")],
      edges: [],
    });
    const storedOn = {
      ...omitted,
      nodes: omitted.nodes.map((node) =>
        node.key !== "action-1"
          ? node
          : {
              ...node,
              attributes: {
                ...node.attributes,
                data: { ...node.attributes.data, enabled: true },
              },
            }
      ),
    };
    const storedOff = createSerializedWorkflowGraph({
      nodes: [
        {
          ...actionNode("action-1", "Send"),
          data: { ...actionNode("action-1", "Send").data, enabled: false },
        },
      ],
      edges: [],
    });

    expect(graphDigest(omitted)).toBe(graphDigest(storedOn));
    expect(draftDiffersFromPublished(omitted, storedOn)).toBe(false);
    expect(draftDiffersFromPublished(storedOn, omitted)).toBe(false);
    expect(draftDiffersFromPublished(omitted, storedOff)).toBe(true);
  });

  it("changes the semantic graph digest when node configuration changes", () => {
    const before = createSerializedWorkflowGraph({
      nodes: [actionNode("action-1", "Send")],
      edges: [],
    });
    const after = createSerializedWorkflowGraph({
      nodes: [
        {
          ...actionNode("action-1", "Send"),
          data: {
            ...actionNode("action-1", "Send").data,
            config: { actionType: "Delay" },
          },
        },
      ],
      edges: [],
    });

    expect(graphDigest(before)).not.toBe(graphDigest(after));
  });

  it("fingerprints an empty catalog stably", () => {
    expect(catalogFingerprint(emptyExtensionCatalog)).toBe(
      catalogFingerprint(emptyExtensionCatalog)
    );
  });

  // A version pins the fingerprint it was published against, and every later
  // run of that version compares the live one against it. A mismatch fails the
  // action node and asks for a republish, so anything the fingerprint reads
  // that is not part of the surface turns a cosmetic edit into that failure.
  // Declaration order is exactly such a thing: the catalog arrays arrive in the
  // order the host wrote them, and reordering renames nothing.
  it("ignores the order the host declared its actions in", () => {
    const oneOrder = catalogOf({
      actions: [anAction("mail/send"), anAction("sms/send")],
    });
    const theOther = catalogOf({
      actions: [anAction("sms/send"), anAction("mail/send")],
    });

    expect(catalogFingerprint(oneOrder)).toBe(catalogFingerprint(theOther));
  });

  it("ignores the order of events and integrations", () => {
    const oneOrder = catalogOf({
      events: [anEvent("app/a.happened"), anEvent("app/b.happened")],
      integrations: [anIntegration("gmail"), anIntegration("slack")],
    });
    const theOther = catalogOf({
      events: [anEvent("app/b.happened"), anEvent("app/a.happened")],
      integrations: [anIntegration("slack"), anIntegration("gmail")],
    });

    expect(catalogFingerprint(oneOrder)).toBe(catalogFingerprint(theOther));
  });

  // Field order decides how the editor stacks a config form and nothing else,
  // so moving a field must not strand every published version either.
  it("ignores the order of an action's config and output fields", () => {
    const oneOrder = catalogOf({
      actions: [
        {
          ...anAction("mail/send"),
          configFields: [aField("to"), aField("cc")],
        },
      ],
    });
    const theOther = catalogOf({
      actions: [
        {
          ...anAction("mail/send"),
          configFields: [aField("cc"), aField("to")],
        },
      ],
    });

    expect(catalogFingerprint(oneOrder)).toBe(catalogFingerprint(theOther));
  });

  // The controls for the above: order stops counting, and identity keeps
  // counting. A fingerprint that ignored everything would pass the three tests
  // above and guard nothing.
  it("changes when an action id changes", () => {
    expect(
      catalogFingerprint(catalogOf({ actions: [anAction("mail/send")] }))
    ).not.toBe(
      catalogFingerprint(catalogOf({ actions: [anAction("mail/deliver")] }))
    );
  });

  it("changes when an action gains a config field", () => {
    const before = catalogOf({
      actions: [{ ...anAction("mail/send"), configFields: [aField("to")] }],
    });
    const after = catalogOf({
      actions: [
        {
          ...anAction("mail/send"),
          configFields: [aField("to"), aField("cc")],
        },
      ],
    });

    expect(catalogFingerprint(before)).not.toBe(catalogFingerprint(after));
  });

  it("ignores whether an action is hidden", () => {
    const visible = catalogOf({
      actions: [anAction("mail/send")],
    });
    const hidden = catalogOf({
      actions: [{ ...anAction("mail/send"), hidden: true }],
    });

    expect(catalogFingerprint(visible)).toBe(catalogFingerprint(hidden));
  });

  // A collision here reads a changed surface as unchanged, which is the one
  // failure this guard exists to catch, so it hashes with SHA-256 like
  // graphDigest rather than with the SHA-1 it started on.
  it("fingerprints with SHA-256", () => {
    expect(catalogFingerprint(emptyExtensionCatalog)).toHaveLength(64);
  });
});
