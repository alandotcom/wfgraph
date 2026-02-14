import { describe, expect, it } from "bun:test";
import type { Workflow } from "@/backend/lib/db/schema";
import {
  buildWorkflowUpdateData,
  toWorkflowApiPayload,
} from "./workflow-mappers.workflows";

function createWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf_public",
    name: "Public Workflow",
    description: null,
    graph: { nodes: [], edges: [] },
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
});
