import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "@rova/shared/workflow/graph";
import {
  orpcQuery,
  refreshIntegrations,
  refreshRunHistory,
  refreshWorkflowList,
} from "./rpc-query";

// These helpers are the client's only statement of what a write invalidates, so
// what they must not do matters as much as what they do: reaching for an area
// key like `orpcQuery.workflow.key()` would sweep the editor's polling run
// queries on every workflow write.

const aWorkflow = (id: string) => ({
  id,
  name: id,
  graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
  isPaused: false,
  mode: "live" as const,
  visibility: "private" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** One page of runs, matching what the dashboard asks for. */
const RUNS_PAGE_SIZE = 100;

const workflowListKey = orpcQuery.workflow.getAll.queryKey({ input: {} });

// The dashboard pages through runs behind a filter, so its entry is an infinite
// one keyed on that filter. Seeding two of them is the point: one invalidation
// has to reach every filter variant, not just the unfiltered one.
const runHistoryKey = (statuses?: ["failed"]) =>
  orpcQuery.workflow.getExecutionsGlobal.infiniteKey({
    input: (cursor: undefined) => ({ limit: RUNS_PAGE_SIZE, statuses, cursor }),
    initialPageParam: undefined,
  });

const workflowRunsKey = (workflowId: string) =>
  orpcQuery.workflow.getExecutions.queryKey({ input: { workflowId } });

const workflowKey = (workflowId: string) =>
  orpcQuery.workflow.getById.queryKey({ input: { workflowId } });

const integrationsKey = orpcQuery.integration.getAll.queryKey({ input: {} });

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient();
  queryClient.setQueryData(workflowListKey, []);
  queryClient.setQueryData(workflowKey("a"), aWorkflow("a"));
  queryClient.setQueryData(workflowRunsKey("a"), {
    items: [],
    supersededCount: 0,
    refusedStarts: [],
  });
  queryClient.setQueryData(integrationsKey, []);
  for (const statuses of [undefined, ["failed"] satisfies ["failed"]]) {
    queryClient.setQueryData(runHistoryKey(statuses), {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    });
  }
});

function isInvalidated(queryKey: readonly unknown[]): boolean {
  return (
    queryClient.getQueryCache().find({ queryKey, exact: true })?.state
      .isInvalidated ?? false
  );
}

describe("refreshWorkflowList", () => {
  it("marks the workflow list stale", async () => {
    await refreshWorkflowList(queryClient);

    expect(isInvalidated(workflowListKey)).toBe(true);
  });

  it("leaves run history and a single workflow alone", async () => {
    await refreshWorkflowList(queryClient);

    expect(isInvalidated(runHistoryKey())).toBe(false);
    expect(isInvalidated(workflowRunsKey("a"))).toBe(false);
    expect(isInvalidated(workflowKey("a"))).toBe(false);
  });
});

describe("refreshRunHistory", () => {
  it("marks every filter variant of the dashboard's history stale", async () => {
    await refreshRunHistory(queryClient);

    expect(isInvalidated(runHistoryKey())).toBe(true);
    expect(isInvalidated(runHistoryKey(["failed"]))).toBe(true);
  });

  // The refusals ride in the same payload as the runs, so the key that covers one
  // covers the other.
  it("marks the editor's per-workflow run list stale", async () => {
    await refreshRunHistory(queryClient);

    expect(isInvalidated(workflowRunsKey("a"))).toBe(true);
  });

  it("leaves the workflow itself alone", async () => {
    await refreshRunHistory(queryClient);

    expect(isInvalidated(workflowKey("a"))).toBe(false);
    expect(isInvalidated(workflowListKey)).toBe(false);
  });
});

describe("refreshIntegrations", () => {
  it("marks the connection list stale and nothing else", async () => {
    await refreshIntegrations(queryClient);

    expect(isInvalidated(integrationsKey)).toBe(true);
    expect(isInvalidated(workflowListKey)).toBe(false);
  });
});
