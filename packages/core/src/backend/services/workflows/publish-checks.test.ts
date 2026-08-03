import { describe, expect, it } from "vitest";
import {
  checkCanceledBranchNeedsCancelEvent,
  checkUnreachableSubtrees,
  reachableNodeIds,
} from "#src/backend/services/workflows/publish-checks";
import {
  catalogFingerprint,
  graphDigest,
} from "#src/backend/services/workflows/version-digest";
import { emptyExtensionCatalog } from "@rova/shared/extensions/catalog";
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

  it("flags a Canceled branch with no Cancel Event", () => {
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

    expect(checkCanceledBranchNeedsCancelEvent({ nodes, edges })).toEqual({
      valid: false,
      error: expect.stringContaining("Cancel Event"),
    });
  });

  it("accepts a Canceled branch when a Cancel Event is declared", () => {
    const withCancel = {
      ...lifecycle,
      data: {
        ...lifecycle.data,
        config: {
          lifecycleRules: {
            startEvents: ["app/appointment.created"],
            cancelEvents: ["app/appointment.canceled"],
            concurrency: "unlimited" as const,
          },
        },
      },
    };
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
        nodes: [withCancel, onCancel],
        edges: [
          {
            id: "e1",
            source: withCancel.id,
            target: onCancel.id,
            sourceHandle: LIFECYCLE_CANCELED_HANDLE,
          },
        ],
      })
    );

    expect(checkCanceledBranchNeedsCancelEvent({ nodes, edges })).toEqual({
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

  it("fingerprints an empty catalog stably", () => {
    expect(catalogFingerprint(emptyExtensionCatalog)).toBe(
      catalogFingerprint(emptyExtensionCatalog)
    );
  });
});
