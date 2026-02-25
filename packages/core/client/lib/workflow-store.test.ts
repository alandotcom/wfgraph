import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "bun:test";
import { createStore } from "jotai";
import type { WorkflowEdge, WorkflowNode } from "@/shared/workflow/types";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });

  if (!resolveFn) {
    throw new Error("Deferred resolver was not initialized");
  }

  return {
    promise,
    resolve: resolveFn,
  };
}

const pendingUpdateDeferreds: Deferred<void>[] = [];
const updateMock = vi.fn(
  (
    _workflowId: string,
    _payload: {
      nodes: WorkflowNode[];
      edges: WorkflowEdge[];
    }
  ) => {
    const deferred = createDeferred<void>();
    pendingUpdateDeferreds.push(deferred);
    return deferred.promise.then(() => ({}));
  }
);

const { api } = await import("./rpc-client");
const originalUpdate = api.workflow.update;

const {
  autosaveAtom,
  currentWorkflowIdAtom,
  edgesAtom,
  hasUnsavedChangesAtom,
  nodesAtom,
} = await import("./workflow-store");

function createActionNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: "action",
      config: {
        actionType: "HTTP Request",
        endpoint: "https://example.com",
      },
    },
  };
}

function createEdge(id: string, source: string, target: string): WorkflowEdge {
  return {
    id,
    source,
    target,
    type: "animated",
  };
}

describe("autosaveAtom", () => {
  beforeAll(() => {
    // The store reads api.workflow.update at call time, so rebinding here keeps
    // this test isolated without global module-mock side effects.
    api.workflow.update = updateMock as unknown as typeof api.workflow.update;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    pendingUpdateDeferreds.length = 0;
  });

  afterAll(() => {
    api.workflow.update = originalUpdate;
  });

  it("queues immediate saves and flushes them sequentially with latest snapshot", async () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(nodesAtom, [createActionNode("node_1")]);
    store.set(edgesAtom, [createEdge("edge_1", "node_1", "node_2")]);
    store.set(hasUnsavedChangesAtom, true);

    const firstSave = store.set(autosaveAtom, { immediate: true });
    expect(updateMock).toHaveBeenCalledTimes(1);

    store.set(nodesAtom, [createActionNode("node_2")]);
    store.set(edgesAtom, [createEdge("edge_2", "node_2", "node_3")]);
    store.set(hasUnsavedChangesAtom, true);

    const secondSave = store.set(autosaveAtom, { immediate: true });
    expect(updateMock).toHaveBeenCalledTimes(1);

    pendingUpdateDeferreds.shift()?.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock.mock.calls[0]?.[1]).toMatchObject({
      nodes: [expect.objectContaining({ id: "node_1" })],
      edges: [expect.objectContaining({ id: "edge_1" })],
    });
    expect(updateMock.mock.calls[1]?.[1]).toMatchObject({
      nodes: [expect.objectContaining({ id: "node_2" })],
      edges: [expect.objectContaining({ id: "edge_2" })],
    });

    pendingUpdateDeferreds.shift()?.resolve();
    await firstSave;
    await secondSave;
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
  });

  it("keeps unsaved changes when a stale save finishes after workflow switch", async () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(nodesAtom, [createActionNode("node_1")]);
    store.set(edgesAtom, []);
    store.set(hasUnsavedChangesAtom, true);

    const savePromise = store.set(autosaveAtom, { immediate: true });
    expect(updateMock).toHaveBeenCalledTimes(1);

    store.set(currentWorkflowIdAtom, "workflow_2");
    store.set(hasUnsavedChangesAtom, true);

    pendingUpdateDeferreds.shift()?.resolve();
    await savePromise;

    expect(store.get(hasUnsavedChangesAtom)).toBe(true);
  });
});
