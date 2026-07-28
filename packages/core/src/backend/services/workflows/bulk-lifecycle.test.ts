import { beforeEach, describe, expect, it, vi } from "vitest";
import { failure, success } from "#src/backend/lib/service-result";
import { postWorkflowsBulkLifecycleResult } from "#src/backend/services/workflows/bulk-lifecycle";

const mocks = vi.hoisted(() => {
  const findFirst = vi.fn();
  const where = vi.fn();
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
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
    logger,
  };
});

vi.mock("#src/backend/lib/db/index", () => ({
  db: {
    query: {
      workflows: {
        findFirst: mocks.findFirst,
      },
    },
    update: mocks.update,
  },
}));

vi.mock("#src/backend/lib/logger", () => ({
  getAppLogger: () => mocks.logger,
}));

describe("postWorkflowsBulkLifecycleResult", () => {
  // Deleting one workflow arrives as a callback, so these tests hand over a fake
  // one and never reach the Effect runtime or a database.
  const deleteOne = vi.fn();

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
      deleteOne,
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
    expect(deleteOne).not.toHaveBeenCalled();
  });

  it("deduplicates workflow ids and preserves delete failures", async () => {
    deleteOne
      .mockResolvedValueOnce(success({ success: true }))
      .mockResolvedValueOnce(
        failure("not_found", { error: "Workflow not found" })
      );

    const result = await postWorkflowsBulkLifecycleResult({
      workflowIds: ["wf_1", "wf_1", "wf_2"],
      action: "delete",
      deleteOne,
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
    expect(deleteOne).toHaveBeenCalledTimes(2);
  });
});
