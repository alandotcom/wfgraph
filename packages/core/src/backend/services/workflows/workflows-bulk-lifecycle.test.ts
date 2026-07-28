import { beforeEach, describe, expect, it, vi } from "vitest";
import { postWorkflowsBulkLifecycleResult } from "@/backend/services/workflows/workflows-bulk-lifecycle";

const mocks = vi.hoisted(() => {
  const findFirst = vi.fn();
  const where = vi.fn();
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const deleteWorkflow = vi.fn();
  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    with: vi.fn(),
  };

  logger.with.mockReturnValue(logger);

  return {
    findFirst,
    where,
    set,
    update,
    deleteWorkflow,
    logger,
  };
});

vi.mock("@/backend/lib/db", () => ({
  db: {
    query: {
      workflows: {
        findFirst: mocks.findFirst,
      },
    },
    update: mocks.update,
  },
}));

vi.mock("@/backend/lib/logger", () => ({
  getAppLogger: () => mocks.logger,
}));

vi.mock("@/backend/services/workflows/workflow", () => ({
  deleteWorkflow: mocks.deleteWorkflow,
}));

describe("postWorkflowsBulkLifecycleResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logger.with.mockReturnValue(mocks.logger);
    mocks.update.mockReturnValue({ set: mocks.set });
    mocks.set.mockReturnValue({ where: mocks.where });
    mocks.where.mockResolvedValue([]);
  });

  it("runs pause action in best-effort mode", async () => {
    mocks.findFirst
      .mockResolvedValueOnce({ id: "wf_1", isPaused: false })
      .mockResolvedValueOnce(undefined);

    const result = await postWorkflowsBulkLifecycleResult({
      workflowIds: ["wf_1", "wf_missing"],
      action: "pause",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.summary).toEqual({
      requested: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(result.data.results).toEqual([
      { workflowId: "wf_1", action: "pause", ok: true },
      {
        workflowId: "wf_missing",
        action: "pause",
        ok: false,
        error: "Workflow not found",
      },
    ]);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("deduplicates workflow ids and preserves delete failures", async () => {
    mocks.deleteWorkflow
      .mockResolvedValueOnce({ ok: true, data: { success: true } })
      .mockResolvedValueOnce({
        ok: false,
        kind: "not_found",
        error: { error: "Workflow not found" },
      });

    const result = await postWorkflowsBulkLifecycleResult({
      workflowIds: ["wf_1", "wf_1", "wf_2"],
      action: "delete",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.summary).toEqual({
      requested: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(result.data.results).toEqual([
      { workflowId: "wf_1", action: "delete", ok: true, deleted: true },
      {
        workflowId: "wf_2",
        action: "delete",
        ok: false,
        error: "Workflow not found",
      },
    ]);
    expect(mocks.deleteWorkflow).toHaveBeenCalledTimes(2);
  });
});
