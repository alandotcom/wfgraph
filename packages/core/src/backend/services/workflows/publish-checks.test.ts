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
} from "@rova/shared/extensions/catalog";
import { emptyExtensionCatalog } from "@rova/shared/extensions/catalog";
import type { ActionConfigField } from "@rova/shared/plugins/action-fields";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@rova/shared/graph/graph";
import { LIFECYCLE_CANCELED_HANDLE } from "@rova/shared/lifecycle/lifecycle-outlets";

const lifecycle = {
  id: "lifecycle-1",
  type: "lifecycle" as const,
  position: { x: 0, y: 0 },
  data: {
    label: "Start",
    type: "lifecycle" as const,
    config: {
      lifecycleRules: {
        startEvents: ["app/appointment.created"],
        cancelEvents: [] as string[],
        concurrency: "unlimited" as const,
      },
    },
  },
};

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
    const orphan = {
      id: "orphan",
      type: "action" as const,
      position: { x: 100, y: 0 },
      data: {
        label: "Orphan",
        type: "action" as const,
        config: { actionType: "Wait" },
      },
    };
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

  // A Canceled branch with no Cancel Event is drawable and never entered; the
  // editor shows it inactive. Publish must not refuse it as unreachable.
  it("treats a Canceled branch as reachable even with no Cancel Event", () => {
    const onCancel = {
      id: "on-cancel",
      type: "action" as const,
      position: { x: 0, y: 100 },
      data: {
        label: "Cleanup",
        type: "action" as const,
        config: { actionType: "Wait" },
      },
    };
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

    expect(reachableNodeIds({ nodes, edges }).has("on-cancel")).toBe(true);
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

  it("detects a draft that no longer matches the published graph", () => {
    const published = createSerializedWorkflowGraph({
      nodes: [lifecycle],
      edges: [],
    });
    const moved = createSerializedWorkflowGraph({
      nodes: [{ ...lifecycle, position: { x: 40, y: 0 } }],
      edges: [],
    });

    expect(draftDiffersFromPublished(published, graphDigest(published))).toBe(
      false
    );
    expect(draftDiffersFromPublished(moved, graphDigest(published))).toBe(true);
    expect(draftDiffersFromPublished(moved, null)).toBe(false);
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

  // A collision here reads a changed surface as unchanged, which is the one
  // failure this guard exists to catch, so it hashes with SHA-256 like
  // graphDigest rather than with the SHA-1 it started on.
  it("fingerprints with SHA-256", () => {
    expect(catalogFingerprint(emptyExtensionCatalog)).toHaveLength(64);
  });

  // Postgres jsonb does not keep the key order a value was written with: a
  // node written as {id, type, position, data} reads back {id, data, type,
  // position}. draftDiffersFromPublished compares a freshly-read draft
  // against a digest stored at publish time, so the digest itself must not
  // care about key order, or every draft looks changed right after publish.
  it("hashes the same regardless of object key order", () => {
    const asWritten = {
      id: "a",
      type: "action",
      position: { x: 0, y: 0 },
      data: { label: "A" },
    };
    const asReadBackFromJsonb = {
      id: "a",
      data: { label: "A" },
      type: "action",
      position: { x: 0, y: 0 },
    };

    expect(graphDigest(asWritten)).toBe(graphDigest(asReadBackFromJsonb));
  });
});
