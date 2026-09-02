import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  orpcQuery,
  cacheWorkflow,
  cacheWorkflowPublication,
  configOptionsQueryOptions,
  refreshIntegrations,
  refreshRunHistory,
  refreshWorkflowVersionHistory,
  refreshWorkflowList,
  selectPublicationState,
} from "./rpc-query";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

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
  hasUnpublishedChanges: false,
});

/** One page of runs, matching what the dashboard asks for. */
const RUNS_PAGE_SIZE = 100;

const workflowListKey = orpcQuery.workflow.getAll.queryKey({ input: {} });

// The dashboard pages through runs behind a filter, so its entry is an infinite
// one keyed on that filter. Seeding two of them is the point: one invalidation
// has to reach every filter variant, not just the unfiltered one.
const runHistoryKey = (statuses?: ["failed"]) =>
  orpcQuery.workflow.getExecutionsGlobal.infiniteKey({
    input: (cursor: undefined) =>
      omitUndefined({ limit: RUNS_PAGE_SIZE, statuses, cursor }),
    initialPageParam: undefined,
  });

const workflowRunsKey = (workflowId: string) =>
  orpcQuery.workflow.getExecutions.queryKey({ input: { workflowId } });

const executionLogsKey = (executionId: string) =>
  orpcQuery.workflow.getExecutionLogs.queryKey({ input: { executionId } });

const executionEventsKey = (executionId: string) =>
  orpcQuery.workflow.getExecutionEvents.queryKey({ input: { executionId } });

const executionStatusKey = (executionId: string) =>
  orpcQuery.workflow.getExecutionStatus.queryKey({ input: { executionId } });

const workflowKey = (workflowId: string) =>
  orpcQuery.workflow.getById.queryKey({ input: { workflowId } });

const integrationsKey = orpcQuery.integration.getAll.queryKey({ input: {} });

const configOptionsKey = (integrationId: string, provider = "channels") =>
  configOptionsQueryOptions({ integrationId, provider }).queryKey;

const workflowVersionHistoryKey = (workflowId: string) =>
  orpcQuery.workflow.getVersionHistory.infiniteKey({
    input: (cursor: undefined) => omitUndefined({ workflowId, cursor }),
    initialPageParam: undefined,
  });

const workflowVersionUsageKey = (workflowId: string) =>
  orpcQuery.workflow.getVersionUsage.queryKey({ input: { workflowId } });

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
  queryClient.setQueryData(executionLogsKey("exec_a"), {
    execution: {
      id: "exec_a",
      workflowId: "a",
      workflowVersionId: "ver_a",
      versionKind: "published",
      versionNumber: 1,
      status: "waiting",
      startSource: "manual",
      runMode: "test",
      startEventName: null,
      entityValue: null,
      input: {},
      output: {},
      error: null,
      startedAt: "2026-03-01T10:00:00.000Z",
      completedAt: null,
      duration: null,
    },
    logs: [],
    waits: [],
  });
  queryClient.setQueryData(executionEventsKey("exec_a"), { events: [] });
  queryClient.setQueryData(executionStatusKey("exec_a"), {
    status: "waiting",
    nodeStatuses: [],
  });
  queryClient.setQueryData(workflowVersionHistoryKey("a"), {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  });
  queryClient.setQueryData(workflowVersionUsageKey("a"), { items: [] });
  queryClient.setQueryData(integrationsKey, []);
  queryClient
    .getQueryCache()
    .build(queryClient, { queryKey: configOptionsKey("integration_a") });
  queryClient
    .getQueryCache()
    .build(queryClient, { queryKey: configOptionsKey("integration_b") });
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
    expect(isInvalidated(workflowVersionUsageKey("a"))).toBe(true);
  });

  it("marks the open run's logs, events, and status stale", async () => {
    await refreshRunHistory(queryClient);

    expect(isInvalidated(executionLogsKey("exec_a"))).toBe(true);
    expect(isInvalidated(executionEventsKey("exec_a"))).toBe(true);
    expect(isInvalidated(executionStatusKey("exec_a"))).toBe(true);
  });

  it("leaves the workflow itself alone", async () => {
    await refreshRunHistory(queryClient);

    expect(isInvalidated(workflowKey("a"))).toBe(false);
    expect(isInvalidated(workflowListKey)).toBe(false);
  });
});

describe("refreshWorkflowVersionHistory", () => {
  it("marks version history stale without refreshing workflow or run queries", async () => {
    await refreshWorkflowVersionHistory(queryClient);

    expect(isInvalidated(workflowVersionHistoryKey("a"))).toBe(true);
    expect(isInvalidated(workflowVersionUsageKey("a"))).toBe(true);
    expect(isInvalidated(workflowKey("a"))).toBe(false);
    expect(isInvalidated(workflowRunsKey("a"))).toBe(false);
    expect(isInvalidated(runHistoryKey())).toBe(false);
  });
});

describe("refreshIntegrations", () => {
  it("marks the connection list stale and nothing else", async () => {
    await refreshIntegrations(queryClient);

    expect(isInvalidated(integrationsKey)).toBe(true);
    expect(isInvalidated(workflowListKey)).toBe(false);
  });

  it("marks only the affected connection's provider options stale", async () => {
    await refreshIntegrations(queryClient, "integration_a");

    expect(isInvalidated(integrationsKey)).toBe(true);
    expect(isInvalidated(configOptionsKey("integration_a"))).toBe(true);
    expect(isInvalidated(configOptionsKey("integration_b"))).toBe(false);
    expect(isInvalidated(workflowListKey)).toBe(false);
  });

  // Every connection overlay awaits this before it closes and reports success.
  // `invalidateQueries` settles on the refetch of each *active* match, and a
  // provider options refetch is a round trip through the third party, so an
  // open config panel behind the dialog would otherwise hold the dialog there.
  it("settles without waiting for the provider options refetch", async () => {
    const observer = new QueryObserver(queryClient, {
      queryKey: configOptionsKey("integration_a"),
      queryFn: () => new Promise<never>(() => undefined),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    try {
      await refreshIntegrations(queryClient, "integration_a");

      expect(isInvalidated(configOptionsKey("integration_a"))).toBe(true);
      expect(
        queryClient.getQueryState(configOptionsKey("integration_a"))
          ?.fetchStatus
      ).toBe("fetching");
    } finally {
      unsubscribe();
    }
  });
});

describe("cacheWorkflowPublication", () => {
  it("writes hasUnpublishedChanges into the getById entry", () => {
    cacheWorkflowPublication(queryClient, {
      id: "a",
      hasUnpublishedChanges: true,
    });

    expect(queryClient.getQueryData(workflowKey("a"))).toMatchObject({
      id: "a",
      hasUnpublishedChanges: true,
    });
    expect(isInvalidated(workflowKey("a"))).toBe(false);
  });

  it("writes the published version metadata into the getById entry", () => {
    cacheWorkflowPublication(queryClient, {
      id: "a",
      hasUnpublishedChanges: false,
      publishedVersionId: "version_2",
      publishedVersion: 2,
      publishedAt: "2026-08-23T16:00:00.000Z",
    });

    expect(queryClient.getQueryData(workflowKey("a"))).toMatchObject({
      publishedVersionId: "version_2",
      publishedVersion: 2,
      publishedAt: "2026-08-23T16:00:00.000Z",
    });
  });
});

describe("cacheWorkflow", () => {
  it("replaces the complete getById payload without invalidating run queries", () => {
    const restored = {
      ...aWorkflow("a"),
      name: "Restored draft",
      publishedVersionId: "version_4",
      publishedVersion: 4,
      publishedAt: "2026-08-23T16:00:00.000Z",
    };

    cacheWorkflow(queryClient, restored);

    expect(queryClient.getQueryData(workflowKey("a"))).toEqual(restored);
    expect(isInvalidated(workflowRunsKey("a"))).toBe(false);
  });
});

describe("selectPublicationState", () => {
  it("keeps the current version metadata from the full workflow payload", () => {
    expect(
      selectPublicationState({
        ...aWorkflow("a"),
        publishedVersionId: "version_2",
        publishedVersion: 2,
        publishedAt: "2026-08-23T16:00:00.000Z",
      })
    ).toEqual({
      isPublished: true,
      hasUnpublishedChanges: false,
      publishedVersion: 2,
      publishedAt: "2026-08-23T16:00:00.000Z",
      publishedVersionId: "version_2",
    });
  });
});
