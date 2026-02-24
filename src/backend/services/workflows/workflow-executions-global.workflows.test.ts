import { beforeEach, describe, expect, it, mock, vi } from "bun:test";

const mocks = (() => {
  const limit = vi.fn();
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));
  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    with: vi.fn(),
  };

  logger.with.mockReturnValue(logger);

  return {
    select,
    from,
    innerJoin,
    where,
    orderBy,
    limit,
    logger,
  };
})();

mock.module("@/backend/lib/db", () => ({
  db: {
    select: mocks.select,
  },
}));

mock.module("@/backend/lib/logger", () => ({
  getAppLogger: () => mocks.logger,
}));

const { getWorkflowExecutionsGlobalResult } = await import(
  "@/backend/services/workflows/workflow-executions-global.workflows"
);

describe("getWorkflowExecutionsGlobalResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logger.with.mockReturnValue(mocks.logger);
    mocks.select.mockReturnValue({ from: mocks.from });
    mocks.from.mockReturnValue({ innerJoin: mocks.innerJoin });
    mocks.innerJoin.mockReturnValue({ where: mocks.where });
    mocks.where.mockReturnValue({ orderBy: mocks.orderBy });
    mocks.orderBy.mockReturnValue({ limit: mocks.limit });
  });

  it("returns paginated global workflow executions with cursor", async () => {
    mocks.limit.mockResolvedValueOnce([
      {
        id: "exec_3",
        workflowId: "wf_1",
        workflowName: "Workflow A",
        workflowIsPaused: false,
        status: "running",
        triggerType: "manual",
        runMode: "live",
        triggerEventType: null,
        correlationKey: null,
        workflowRunId: "run_3",
        input: { id: 3 },
        output: null,
        error: null,
        startedAt: new Date("2026-02-18T19:40:00.000Z"),
        waitingAt: null,
        cancelledAt: null,
        completedAt: null,
        duration: null,
      },
      {
        id: "exec_2",
        workflowId: "wf_2",
        workflowName: "Workflow B",
        workflowIsPaused: true,
        status: "waiting",
        triggerType: "webhook",
        runMode: "test",
        triggerEventType: "order.updated",
        correlationKey: "ord_2",
        workflowRunId: "run_2",
        input: { id: 2 },
        output: null,
        error: null,
        startedAt: new Date("2026-02-18T19:39:00.000Z"),
        waitingAt: new Date("2026-02-18T19:39:10.000Z"),
        cancelledAt: null,
        completedAt: null,
        duration: null,
      },
      {
        id: "exec_1",
        workflowId: "wf_3",
        workflowName: "Workflow C",
        workflowIsPaused: false,
        status: "success",
        triggerType: "manual",
        runMode: "live",
        triggerEventType: null,
        correlationKey: null,
        workflowRunId: "run_1",
        input: { id: 1 },
        output: { ok: true },
        error: null,
        startedAt: new Date("2026-02-18T19:38:00.000Z"),
        waitingAt: null,
        cancelledAt: null,
        completedAt: new Date("2026-02-18T19:38:20.000Z"),
        duration: "20000",
      },
    ]);

    const result = await getWorkflowExecutionsGlobalResult({
      limit: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.items).toHaveLength(2);
    expect(result.data.items[0]?.id).toBe("exec_3");
    expect(result.data.items[1]?.workflowIsPaused).toBe(true);
    expect(result.data.nextCursor).toEqual({
      startedAt: "2026-02-18T19:39:00.000Z",
      id: "exec_2",
    });
  });

  it("returns 400 for invalid cursor timestamp", async () => {
    const result = await getWorkflowExecutionsGlobalResult({
      cursor: {
        startedAt: "not-a-date",
        id: "exec_bad",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.status).toBe(400);
    expect(result.error.error).toContain("Invalid cursor.startedAt");
  });
});
