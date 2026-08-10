import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import type { SavedWorkflow } from "#src/lib/rpc-client";
import {
  autosaveDelayAtom,
  createWorkflowAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  hasUnsavedChangesAtom,
  isSavingAtom,
  lastSaveErrorAtom,
  renameWorkflowAtom,
  saveWorkflowAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { savedWorkflow } from "./workflow-save-test-support";

type Deferred = {
  promise: Promise<SavedWorkflow>;
  resolve: (value: SavedWorkflow) => void;
  reject: (error: Error) => void;
};

function createDeferred(): Deferred {
  let resolve: ((value: SavedWorkflow) => void) | null = null;
  let reject: ((error: Error) => void) | null = null;
  const promise = new Promise<SavedWorkflow>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  if (!(resolve && reject)) {
    throw new Error("Deferred resolvers were not initialized");
  }

  return { promise, resolve, reject };
}

const pending: Deferred[] = [];

/** Hands back a promise the test resolves by hand, so flush order is observable. */
const updateMock = vi.fn((_workflowId: string, _payload: unknown) => {
  const deferred = createDeferred();
  pending.push(deferred);
  return deferred.promise;
});

const createMock = vi.fn((input: { name: string }) =>
  Promise.resolve(savedWorkflow(input.name))
);

/** A store wired to the mock API, which is the only thing tests substitute. */
function createSaveStore(workflowId: string | null = "workflow_1") {
  const store = createStore();
  store.set(workflowApiAtom, {
    create: createMock as never,
    update: updateMock as never,
  });
  store.set(currentWorkflowIdAtom, workflowId);
  return store;
}

function actionNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: "action",
      config: { actionType: "custom/send-message" },
    },
  };
}

function edge(id: string, source: string, target: string): WorkflowEdge {
  return { id, source, target, type: "animated" };
}

/** Let a zero-delay debounce timer fire. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * Wait until the store has sent `count` requests. A predicate rather than a
 * fixed number of microtask turns, so adding an `await` inside the queue does
 * not read as a logic failure here.
 */
async function waitForCalls(count: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (updateMock.mock.calls.length >= count) {
      return;
    }
    await tick();
  }
  throw new Error(
    `Expected ${count} update calls, saw ${updateMock.mock.calls.length}`
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  pending.length = 0;
});

describe("saveWorkflowAtom", () => {
  it("coalesces immediate saves and sends them one at a time, newest last", async () => {
    const store = createSaveStore();

    const firstSave = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [edge("edge_1", "a", "b")] },
      { immediate: true }
    );
    expect(updateMock).toHaveBeenCalledTimes(1);

    const secondSave = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_2")], edges: [edge("edge_2", "b", "c")] },
      { immediate: true }
    );
    expect(updateMock).toHaveBeenCalledTimes(1);

    pending.shift()?.resolve(savedWorkflow("workflow_1"));
    await waitForCalls(2);

    expect(updateMock.mock.calls[0]?.[1]).toMatchObject({
      nodes: [expect.objectContaining({ id: "node_1" })],
      edges: [expect.objectContaining({ id: "edge_1" })],
    });
    expect(updateMock.mock.calls[1]?.[1]).toMatchObject({
      nodes: [expect.objectContaining({ id: "node_2" })],
      edges: [expect.objectContaining({ id: "edge_2" })],
    });

    pending.shift()?.resolve(savedWorkflow("workflow_1"));
    await firstSave;
    await secondSave;
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(store.get(isSavingAtom)).toBe(false);
  });

  it("keeps unsaved changes when a stale save lands after a workflow switch", async () => {
    const store = createSaveStore();

    const save = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [] },
      { immediate: true }
    );
    expect(updateMock).toHaveBeenCalledTimes(1);

    store.set(currentWorkflowIdAtom, "workflow_2");
    store.set(hasUnsavedChangesAtom, true);

    pending.shift()?.resolve(savedWorkflow("workflow_1"));
    await save;

    expect(store.get(hasUnsavedChangesAtom)).toBe(true);
  });

  it("still sends an edit queued against the workflow being navigated away from", async () => {
    const store = createSaveStore("workflow_a");
    store.set(autosaveDelayAtom, 0);

    // An edit to A is queued but has not been sent yet.
    const editToA = store.set(saveWorkflowAtom, {
      nodes: [actionNode("from_a")],
      edges: [],
    });

    // The editor switches to B and something writes immediately, which is what
    // the workflow-load path does.
    store.set(currentWorkflowIdAtom, "workflow_b");
    const editToB = store.set(saveWorkflowAtom, {
      nodes: [actionNode("from_b")],
      edges: [],
    });

    await waitForCalls(1);
    pending.shift()?.resolve(savedWorkflow("workflow_a"));
    await waitForCalls(2);
    pending.shift()?.resolve(savedWorkflow("workflow_b"));

    // Neither caller may hang, and A's edit may not be silently dropped.
    expect(await editToA).toMatchObject({ ok: true });
    expect(await editToB).toMatchObject({ ok: true });
    expect(updateMock.mock.calls.map((call) => call[0])).toEqual([
      "workflow_a",
      "workflow_b",
    ]);
  });

  it("collapses a burst of debounced saves into one request", async () => {
    const store = createSaveStore();
    store.set(autosaveDelayAtom, 0);

    store.set(saveWorkflowAtom, { nodes: [actionNode("node_1")], edges: [] });
    store.set(saveWorkflowAtom, { nodes: [actionNode("node_2")], edges: [] });
    const last = store.set(saveWorkflowAtom, {
      nodes: [actionNode("node_3")],
      edges: [],
    });

    expect(updateMock).not.toHaveBeenCalled();

    await waitForCalls(1);
    pending.shift()?.resolve(savedWorkflow("workflow_1"));
    await last;

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0]?.[1]).toMatchObject({
      nodes: [expect.objectContaining({ id: "node_3" })],
    });
  });

  it("merges a rename and a graph edit in the same window into one request", async () => {
    const store = createSaveStore();
    store.set(autosaveDelayAtom, 0);

    store.set(saveWorkflowAtom, { nodes: [actionNode("node_1")], edges: [] });
    const rename = store.set(renameWorkflowAtom, "Renamed");

    await waitForCalls(1);
    pending.shift()?.resolve(savedWorkflow("workflow_1"));
    await rename;

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0]?.[1]).toMatchObject({
      name: "Renamed",
      nodes: [expect.objectContaining({ id: "node_1" })],
    });
  });

  it("gives each store its own debounce, so one cannot cancel another's save", async () => {
    const storeA = createSaveStore("workflow_a");
    const storeB = createSaveStore("workflow_b");
    storeA.set(autosaveDelayAtom, 0);
    storeB.set(autosaveDelayAtom, 0);

    storeA.set(saveWorkflowAtom, { nodes: [actionNode("node_a")], edges: [] });
    storeB.set(saveWorkflowAtom, { nodes: [actionNode("node_b")], edges: [] });

    await waitForCalls(2);

    expect(updateMock.mock.calls.map((call) => call[0]).sort()).toEqual([
      "workflow_a",
      "workflow_b",
    ]);
  });

  it("drops the add placeholder before the graph goes over the wire", async () => {
    const store = createSaveStore();
    const placeholder: WorkflowNode = {
      id: "add_1",
      type: "add",
      position: { x: 0, y: 0 },
      data: { label: "", type: "add" },
    };

    const save = store.set(
      saveWorkflowAtom,
      { nodes: [placeholder, actionNode("node_1")], edges: [] },
      { immediate: true }
    );
    pending.shift()?.resolve(savedWorkflow("workflow_1"));
    await save;

    expect(updateMock.mock.calls[0]?.[1]).toMatchObject({
      nodes: [expect.objectContaining({ id: "node_1" })],
    });
  });

  it("reports a failure to the caller and leaves the workflow dirty", async () => {
    const store = createSaveStore();

    const save = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [] },
      { immediate: true }
    );
    pending.shift()?.reject(new Error("network is down"));
    const outcome = await save;

    expect(outcome).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "network is down" }),
    });
    expect(store.get(hasUnsavedChangesAtom)).toBe(true);
    expect(store.get(lastSaveErrorAtom)?.message).toBe("network is down");
    expect(store.get(isSavingAtom)).toBe(false);
  });

  it("carries a failed patch into a newer queued save", async () => {
    const store = createSaveStore();

    const graphSave = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [] },
      { immediate: true }
    );
    const rename = store.set(
      saveWorkflowAtom,
      { name: "Renamed" },
      { immediate: true }
    );

    pending.shift()?.reject(new Error("network is down"));
    await waitForCalls(2);

    expect(updateMock.mock.calls[1]?.[1]).toMatchObject({
      name: "Renamed",
      nodes: [expect.objectContaining({ id: "node_1" })],
      edges: [],
    });

    pending.shift()?.resolve(savedWorkflow("workflow_1"));
    expect(await graphSave).toMatchObject({ ok: false });
    expect(await rename).toMatchObject({ ok: true });
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(store.get(lastSaveErrorAtom)).toBeNull();
  });

  it("retries a failed patch on the workflow's next save", async () => {
    const store = createSaveStore();

    const graphSave = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [] },
      { immediate: true }
    );
    pending.shift()?.reject(new Error("network is down"));
    expect(await graphSave).toMatchObject({ ok: false });

    const rename = store.set(
      saveWorkflowAtom,
      { name: "Renamed" },
      { immediate: true }
    );
    await waitForCalls(2);

    expect(updateMock.mock.calls[1]?.[1]).toMatchObject({
      name: "Renamed",
      nodes: [expect.objectContaining({ id: "node_1" })],
      edges: [],
    });

    pending.shift()?.resolve(savedWorkflow("workflow_1"));
    expect(await rename).toMatchObject({ ok: true });
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
  });

  it("does nothing when no workflow is open", async () => {
    const store = createSaveStore(null);

    const outcome = await store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [] },
      { immediate: true }
    );

    expect(outcome).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("createWorkflowAtom", () => {
  it("adopts the created workflow's identity", async () => {
    const store = createSaveStore(null);

    const outcome = await store.set(createWorkflowAtom, {
      name: "Fresh",
      nodes: [actionNode("node_1")],
      edges: [],
    });

    expect(outcome.ok).toBe(true);
    expect(store.get(currentWorkflowIdAtom)).toBe("Fresh");
    expect(store.get(currentWorkflowNameAtom)).toBe("Fresh");
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
  });
});
