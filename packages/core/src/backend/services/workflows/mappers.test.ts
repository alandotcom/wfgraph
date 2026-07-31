import { describe, expect, it } from "vitest";
import type { Workflow } from "#src/backend/lib/db/schema";
import {
  createSerializedWorkflowGraph,
  isSerializedWorkflowGraph,
} from "@rova/shared/graph/graph";
import {
  buildWorkflowUpdateData,
  toWorkflowApiPayload,
  withDefaultLifecycleNode,
} from "#src/backend/services/workflows/mappers";

function createWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf_public",
    name: "Public Workflow",
    description: null,
    graph: { nodes: [], edges: [] },
    isPaused: false,
    mode: "live",
    visibility: "public",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("workflow mappers", () => {
  it("maps DB workflow visibility and timestamps into API payload", () => {
    const payload = toWorkflowApiPayload(createWorkflow());

    expect(payload.visibility).toBe("public");
    expect(payload.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(payload.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(payload.description).toBeUndefined();
    expect(payload.isPaused).toBe(false);
    expect(payload.mode).toBe("live");
  });

  it("builds patch update payload without forcing visibility", () => {
    const updatedAt = new Date("2026-01-03T00:00:00.000Z");
    const updateData = buildWorkflowUpdateData(
      { description: "Updated description" },
      updatedAt
    );

    expect(updateData).toEqual({
      description: "Updated description",
      updatedAt,
    });
    expect(Object.hasOwn(updateData, "visibility")).toBe(false);
  });

  it("builds patch update payload with mode when provided", () => {
    const updatedAt = new Date("2026-01-04T00:00:00.000Z");
    const updateData = buildWorkflowUpdateData({ mode: "test" }, updatedAt);

    expect(updateData).toEqual({
      mode: "test",
      updatedAt,
    });
  });
});

/**
 * Both ways a workflow is written for the first time run through this: the
 * create endpoint and the editor's autosave. An empty graph would otherwise
 * save as a workflow that can never be triggered.
 */
describe("withDefaultLifecycleNode", () => {
  it("gives an empty graph a Lifecycle Node to start from", () => {
    const filled = withDefaultLifecycleNode({ nodes: [], edges: [] });

    expect(isSerializedWorkflowGraph(filled)).toBe(true);
    if (!isSerializedWorkflowGraph(filled)) {
      return;
    }

    expect(filled.nodes).toHaveLength(1);
    const node = filled.nodes[0]?.attributes.data;
    expect(node?.type).toBe("lifecycle");
    // The entry node starts with nothing configured: what starts a run is the
    // Lifecycle Rules the panel writes, and it has not been near this graph yet.
    expect(node?.config).toEqual({});
    expect(node?.status).toBe("idle");
  });

  it("hands back a graph that already has nodes", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        {
          id: "action-1",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Send email",
            type: "action",
            config: { actionId: "resend/send-email" },
          },
        },
      ],
      edges: [],
    });

    expect(withDefaultLifecycleNode(graph)).toBe(graph);
  });

  // Deciding whether a value is a graph at all is validation's job, and it runs
  // next, so anything that is not one travels on unchanged rather than being
  // replaced by a graph nobody asked for.
  it("hands back a value that is not a graph", () => {
    expect(withDefaultLifecycleNode("not a graph")).toBe("not a graph");
  });
});
