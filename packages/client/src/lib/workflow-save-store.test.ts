import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { toast } from "sonner";
import { ApiError, type SavedWorkflow } from "#src/lib/rpc-client";
import { DRAFT_CONFLICT_CODE } from "@wfgraph/shared/rpc/error-codes";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  hasUnsavedChangesAtom,
  isSavingAtom,
  lastSaveErrorAtom,
  recordLoadedDraftRevisionAtom,
  hasHeldGraphSaveAtom,
  renameWorkflowAtom,
  retryHeldGraphSavesAtom,
  saveRetryBackoffAtom,
  saveWorkflowAtom,
  setWorkflowModeAtom,
  successfulSaveGenerationAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import {
  hydrateWorkflowAtom,
  nodesAtom,
  remoteDraftChangeAtom,
} from "#src/lib/workflow-graph-store";
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
const updateMock = vi.fn(
  (_workflowId: string, _payload: unknown, _expectedDraftRevision: number) => {
    const deferred = createDeferred();
    pending.push(deferred);
    return deferred.promise;
  }
);

/** A store wired to the mock API, which is the only thing tests substitute. */
function createSaveStore(workflowId: string | null = "workflow_1") {
  const store = createStore();
  store.set(workflowApiAtom, { update: updateMock as never });
  // A failed graph is resent on a timer; a case that is not about that timer
  // keeps it from firing inside a later case of this file.
  store.set(saveRetryBackoffAtom, { initialMs: 600_000, maxMs: 600_000 });
  store.set(currentWorkflowIdAtom, workflowId);
  if (workflowId) {
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId,
      draftRevision: 1,
    });
  }
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
  return { id, source, target };
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
  pending.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
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

    expect(updateMock.mock.calls[0]?.[2]).toBe(1);
    expect(updateMock.mock.calls[1]?.[2]).toBe(1);

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

  it("advances the expected revision after a graph save", async () => {
    const store = createSaveStore();

    const first = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [] },
      { immediate: true }
    );
    pending.shift()?.resolve({
      ...savedWorkflow("workflow_1"),
      draftRevision: 2,
    });
    await first;

    const second = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_2")], edges: [] },
      { immediate: true }
    );
    pending.shift()?.resolve({
      ...savedWorkflow("workflow_1"),
      draftRevision: 3,
    });
    await second;

    expect(updateMock.mock.calls.map((call) => call[2])).toEqual([1, 2]);
  });

  it("blocks retries after a draft conflict until the workflow reloads", async () => {
    const store = createSaveStore();
    const graph = { nodes: [actionNode("node_1")], edges: [] };
    const conflict = new ApiError(
      409,
      "The workflow draft changed",
      DRAFT_CONFLICT_CODE
    );

    const first = store.set(saveWorkflowAtom, graph, { immediate: true });
    pending.shift()?.reject(conflict);
    expect(await first).toMatchObject({ ok: false, error: conflict });

    const blocked = await store.set(
      saveWorkflowAtom,
      { name: "Still local" },
      { immediate: true }
    );
    expect(blocked).toMatchObject({ ok: false, error: conflict });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(store.get(hasUnsavedChangesAtom)).toBe(true);

    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: "workflow_1",
      draftRevision: 2,
    });
    const retry = store.set(saveWorkflowAtom, graph, { immediate: true });
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock.mock.calls[1]?.[2]).toBe(2);
    pending.shift()?.resolve({
      ...savedWorkflow("workflow_1"),
      draftRevision: 3,
    });
    await retry;
  });

  it("advances the workflow generation after a successful write", async () => {
    const store = createSaveStore();

    const save = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [] },
      { immediate: true }
    );
    pending.shift()?.resolve(savedWorkflow("workflow_1"));
    await save;

    expect(store.get(successfulSaveGenerationAtom).get("workflow_1")).toBe(1);
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

  it("reports a failed save once", async () => {
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "");
    const store = createSaveStore();

    const save = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [] },
      { immediate: true }
    );
    pending.shift()?.reject(new Error("network is down"));
    await save;

    expect(errorToast).toHaveBeenCalledTimes(1);
    expect(errorToast).toHaveBeenCalledWith("network is down");
  });

  it("holds a draft conflict as the failure while later edits are refused", async () => {
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "");
    const store = createSaveStore();
    store.set(autosaveDelayAtom, 0);
    const conflict = new ApiError(
      409,
      "The workflow draft changed",
      DRAFT_CONFLICT_CODE
    );

    const first = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [] },
      { immediate: true }
    );
    pending.shift()?.reject(conflict);
    await first;

    const laterEdit = store.set(saveWorkflowAtom, {
      nodes: [actionNode("node_2")],
      edges: [],
    });
    expect(store.get(lastSaveErrorAtom)).toBe(conflict);
    expect(await laterEdit).toMatchObject({ ok: false, error: conflict });

    expect(store.get(lastSaveErrorAtom)).toBe(conflict);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(errorToast).toHaveBeenCalledTimes(1);
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

describe("the failure the open workflow shows", () => {
  it("is cleared when another workflow opens", async () => {
    vi.spyOn(toast, "error").mockImplementation(() => "");
    const store = createSaveStore("workflow_a");

    const save = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [] },
      { immediate: true }
    );
    pending.shift()?.reject(new Error("network is down"));
    await save;
    expect(store.get(lastSaveErrorAtom)?.message).toBe("network is down");

    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_b"));

    expect(store.get(lastSaveErrorAtom)).toBeNull();
  });

  it("does not take a failure of the workflow left behind", async () => {
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "");
    const store = createSaveStore("workflow_a");

    const save = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [] },
      { immediate: true }
    );
    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_b"));
    pending.shift()?.reject(new Error("network is down"));
    await save;

    expect(store.get(lastSaveErrorAtom)).toBeNull();
    expect(errorToast).toHaveBeenCalledWith("network is down");
  });

  it("is not cleared by a save of the workflow left behind", async () => {
    vi.spyOn(toast, "error").mockImplementation(() => "");
    const store = createSaveStore("workflow_a");

    const save = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [] },
      { immediate: true }
    );
    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_b"));
    const frame: WorkflowNode = {
      id: "g",
      type: "group",
      position: { x: 0, y: 0 },
      data: { label: "Group", type: "group" },
    };
    const refused = await store.set(saveWorkflowAtom, {
      nodes: [
        frame,
        { ...actionNode("a"), parentId: "g", extent: "parent" },
        { ...actionNode("b"), parentId: "g", extent: "parent" },
      ],
      edges: [edge("onto_frame", "a", "g")],
    });
    expect(refused).toMatchObject({ ok: false });

    pending.shift()?.resolve(savedWorkflow("workflow_a"));
    await save;

    expect(store.get(lastSaveErrorAtom)).toBe(
      refused?.ok === false ? refused.error : undefined
    );
  });
});

describe("reopening a workflow whose save has not landed", () => {
  function openWorkflowA() {
    const store = createSaveStore(null);
    store.set(
      hydrateWorkflowAtom,
      savedWorkflow("workflow_a", { nodes: [actionNode("before")], edges: [] })
    );
    return store;
  }

  /** What the route loader hands the editor: the server's graph from before the save. */
  function reopenWithServerSnapshot(store: ReturnType<typeof createSaveStore>) {
    store.set(hydrateWorkflowAtom, {
      ...savedWorkflow("workflow_a", {
        nodes: [actionNode("before")],
        edges: [],
      }),
      saveGeneration:
        store.get(successfulSaveGenerationAtom).get("workflow_a") ?? 0,
    });
  }

  const savedAfter = () => ({
    ...savedWorkflow("workflow_a", { nodes: [actionNode("after")], edges: [] }),
    draftRevision: 2,
  });

  it("shows the edit still in flight, and calls it saved once it lands", async () => {
    const store = openWorkflowA();
    const save = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("after")], edges: [] },
      { immediate: true }
    );
    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_b"));

    reopenWithServerSnapshot(store);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["after"]);
    expect(store.get(hasUnsavedChangesAtom)).toBe(true);

    pending.shift()?.resolve(savedAfter());
    await save;

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["after"]);
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
  });

  it("shows the edit still waiting for the debounce", async () => {
    const store = openWorkflowA();
    store.set(autosaveDelayAtom, 0);
    const save = store.set(saveWorkflowAtom, {
      nodes: [actionNode("after")],
      edges: [],
    });
    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_b"));

    reopenWithServerSnapshot(store);
    await waitForCalls(1);
    pending.shift()?.resolve(savedAfter());
    await save;

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["after"]);
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
  });
});

describe("a graph whose save failed", () => {
  function openWorkflowA() {
    const store = createSaveStore(null);
    store.set(
      hydrateWorkflowAtom,
      savedWorkflow("workflow_a", { nodes: [actionNode("before")], edges: [] })
    );
    return store;
  }

  /** The route loader's snapshot of A: the server never stored the failed edit. */
  function reopenA(
    store: ReturnType<typeof createSaveStore>,
    draftRevision = 1
  ) {
    store.set(hydrateWorkflowAtom, {
      ...savedWorkflow("workflow_a", {
        nodes: [actionNode("before")],
        edges: [],
      }),
      draftRevision,
      saveGeneration:
        store.get(successfulSaveGenerationAtom).get("workflow_a") ?? 0,
    });
  }

  async function failGraphSaveOfA(store: ReturnType<typeof createSaveStore>) {
    const save = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("after")], edges: [] },
      { immediate: true }
    );
    pending.shift()?.reject(new ApiError(500, "network is down"));
    await save;
  }

  it("comes back with its failure when the workflow is reopened, and is sent again", async () => {
    vi.spyOn(toast, "error").mockImplementation(() => "");
    const store = openWorkflowA();
    store.set(saveRetryBackoffAtom, { initialMs: 60_000, maxMs: 60_000 });
    await failGraphSaveOfA(store);

    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_b"));
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(store.get(hasHeldGraphSaveAtom)).toBe(true);

    reopenA(store);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["after"]);
    expect(store.get(hasUnsavedChangesAtom)).toBe(true);
    expect(store.get(lastSaveErrorAtom)?.message).toBe("network is down");

    await waitForCalls(2);
    expect(updateMock.mock.calls[1]?.[0]).toBe("workflow_a");
    expect(updateMock.mock.calls[1]?.[1]).toMatchObject({
      nodes: [expect.objectContaining({ id: "after" })],
    });
    pending.shift()?.resolve({
      ...savedWorkflow("workflow_a", {
        nodes: [actionNode("after")],
        edges: [],
      }),
      draftRevision: 2,
    });
    await vi.waitFor(() => {
      expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    });
    expect(store.get(lastSaveErrorAtom)).toBeNull();
    expect(store.get(hasHeldGraphSaveAtom)).toBe(false);
  });

  it("is sent again against the revision it was written on, so a newer server draft is a conflict", async () => {
    vi.spyOn(toast, "error").mockImplementation(() => "");
    const store = openWorkflowA();
    store.set(saveRetryBackoffAtom, { initialMs: 60_000, maxMs: 60_000 });
    await failGraphSaveOfA(store);
    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_b"));

    // Another client wrote A at revision 2 while the editor was away.
    reopenA(store, 2);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["after"]);

    await waitForCalls(2);
    expect(updateMock.mock.calls[1]?.[2]).toBe(1);
    pending
      .shift()
      ?.reject(
        new ApiError(409, "The workflow draft changed", DRAFT_CONFLICT_CODE)
      );
    await vi.waitFor(() => {
      expect(store.get(isSavingAtom)).toBe(false);
    });

    expect(store.get(remoteDraftChangeAtom)).toEqual({
      workflowId: "workflow_a",
      draftRevision: 2,
    });
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["after"]);
  });

  it("is sent again on its own after a backoff", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(toast, "error").mockImplementation(() => "");
      const store = openWorkflowA();
      store.set(saveRetryBackoffAtom, { initialMs: 1000, maxMs: 30_000 });
      await failGraphSaveOfA(store);
      expect(updateMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(updateMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(updateMock).toHaveBeenCalledTimes(2);
      expect(updateMock.mock.calls[1]?.[2]).toBe(1);

      // A second failure doubles the wait.
      pending.shift()?.reject(new ApiError(503, "unavailable"));
      await vi.advanceTimersByTimeAsync(1999);
      expect(updateMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(updateMock).toHaveBeenCalledTimes(3);

      pending.shift()?.resolve({
        ...savedWorkflow("workflow_a"),
        draftRevision: 2,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.get(hasUnsavedChangesAtom)).toBe(false);
      expect(store.get(lastSaveErrorAtom)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is sent again when asked, which is what the browser coming online does", async () => {
    vi.spyOn(toast, "error").mockImplementation(() => "");
    const store = openWorkflowA();
    store.set(saveRetryBackoffAtom, { initialMs: 60_000, maxMs: 60_000 });
    await failGraphSaveOfA(store);

    store.set(retryHeldGraphSavesAtom);
    await waitForCalls(2);
    pending.shift()?.resolve({
      ...savedWorkflow("workflow_a"),
      draftRevision: 2,
    });
    await vi.waitFor(() => {
      expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    });
  });

  it("reports an automatic retry's failure in the status, not in another toast", async () => {
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "");
    const store = openWorkflowA();
    store.set(saveRetryBackoffAtom, { initialMs: 60_000, maxMs: 60_000 });
    await failGraphSaveOfA(store);

    store.set(retryHeldGraphSavesAtom);
    await waitForCalls(2);
    pending.shift()?.reject(new ApiError(500, "still down"));
    await vi.waitFor(() => {
      expect(store.get(isSavingAtom)).toBe(false);
    });

    expect(errorToast).toHaveBeenCalledTimes(1);
    expect(store.get(lastSaveErrorAtom)?.message).toBe("still down");
  });

  it("is not sent again on its own when the server refused the graph itself", async () => {
    vi.spyOn(toast, "error").mockImplementation(() => "");
    const store = openWorkflowA();
    store.set(saveRetryBackoffAtom, { initialMs: 0, maxMs: 0 });
    const save = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("after")], edges: [] },
      { immediate: true }
    );
    pending.shift()?.reject(new ApiError(400, "Invalid graph payload"));
    await save;

    store.set(retryHeldGraphSavesAtom);
    await tick();
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(store.get(hasUnsavedChangesAtom)).toBe(true);
  });

  it("is sent again alone when the refusal may have been the rename it travelled with", async () => {
    vi.spyOn(toast, "error").mockImplementation(() => "");
    const store = openWorkflowA();
    store.set(autosaveDelayAtom, 0);
    store.set(saveRetryBackoffAtom, { initialMs: 0, maxMs: 0 });

    store.set(saveWorkflowAtom, { nodes: [actionNode("after")], edges: [] });
    const rename = store.set(renameWorkflowAtom, "Taken name");
    await waitForCalls(1);
    pending
      .shift()
      ?.reject(new ApiError(409, 'Workflow name "Taken name" already exists'));
    expect(await rename).toBeInstanceOf(Error);

    await waitForCalls(2);
    expect(updateMock.mock.calls[1]?.[1]).toMatchObject({
      nodes: [expect.objectContaining({ id: "after" })],
    });
    expect(updateMock.mock.calls[1]?.[1]).not.toHaveProperty("name");
    pending.shift()?.resolve({
      ...savedWorkflow("workflow_a"),
      draftRevision: 2,
    });
    await vi.waitFor(() => {
      expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    });
  });
});

describe("setWorkflowModeAtom", () => {
  it("does not send a mode switch that failed with a later save", async () => {
    const store = createSaveStore();

    const modeSwitch = store.set(setWorkflowModeAtom, "test");
    pending.shift()?.reject(new Error("network is down"));
    expect(await modeSwitch).toMatchObject({ ok: false });

    const graphSave = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [] },
      { immediate: true }
    );
    await waitForCalls(2);
    pending.shift()?.resolve(savedWorkflow("workflow_1"));
    await graphSave;

    expect(updateMock.mock.calls[1]?.[1]).not.toHaveProperty("mode");
  });

  it("does not send a mode switch that failed alongside a graph edit with a later save", async () => {
    const store = createSaveStore();
    store.set(autosaveDelayAtom, 0);

    const graphEdit = store.set(saveWorkflowAtom, {
      nodes: [actionNode("node_1")],
      edges: [],
    });
    const modeSwitch = store.set(setWorkflowModeAtom, "test");
    pending.shift()?.reject(new Error("network is down"));
    await Promise.all([graphEdit, modeSwitch]);

    const retry = store.set(
      saveWorkflowAtom,
      { name: "Renamed" },
      { immediate: true }
    );
    await waitForCalls(2);
    pending.shift()?.resolve(savedWorkflow("workflow_1"));
    await retry;

    expect(updateMock.mock.calls[1]?.[1]).toMatchObject({
      nodes: [expect.objectContaining({ id: "node_1" })],
    });
    expect(updateMock.mock.calls[1]?.[1]).not.toHaveProperty("mode");
  });
});

describe("renameWorkflowAtom", () => {
  it("puts the old name back and keeps a refused one out of every later save", async () => {
    const store = createSaveStore();
    store.set(autosaveDelayAtom, 0);
    store.set(currentWorkflowNameAtom, "Appointment reminders");

    const rename = store.set(renameWorkflowAtom, "Onboarding drip");
    await waitForCalls(1);
    pending
      .shift()
      ?.reject(new Error('Workflow name "Onboarding drip" already exists'));
    const failure = await rename;

    expect(failure?.message).toContain("already exists");
    expect(store.get(currentWorkflowNameAtom)).toBe("Appointment reminders");

    // The queue retries a failed patch with the next write, which for a name
    // the server will never accept means every later save fails too. One
    // rejected rename used to stop the editor saving for the rest of the
    // session, and the graph went with it.
    store.set(saveWorkflowAtom, { nodes: [actionNode("node_1")], edges: [] });
    await waitForCalls(2);
    pending.shift()?.resolve(savedWorkflow("workflow_1"));

    expect(updateMock.mock.calls[1]?.[1]).not.toHaveProperty("name");
  });

  it("does not roll a failed rename into the workflow opened while it was saving", async () => {
    const store = createSaveStore("workflow_a");
    store.set(currentWorkflowNameAtom, "Workflow A");

    const rename = store.set(renameWorkflowAtom, "Renamed A");
    await waitForCalls(1);

    store.set(currentWorkflowIdAtom, "workflow_b");
    store.set(currentWorkflowNameAtom, "Workflow B");
    pending.shift()?.reject(new Error("name refused"));
    await rename;

    expect(store.get(currentWorkflowNameAtom)).toBe("Workflow B");
  });

  it("does not let an older failed rename replace a newer one", async () => {
    const store = createSaveStore();
    store.set(currentWorkflowNameAtom, "Original");

    const firstRename = store.set(renameWorkflowAtom, "First");
    await waitForCalls(1);
    const secondRename = store.set(renameWorkflowAtom, "Second");

    pending.shift()?.reject(new Error("first name refused"));
    await waitForCalls(2);
    pending.shift()?.resolve({
      ...savedWorkflow("workflow_1"),
      name: "Second",
    });
    await Promise.all([firstRename, secondRename]);

    expect(store.get(currentWorkflowNameAtom)).toBe("Second");
  });

  it("restores the last saved name when concurrent renames both fail", async () => {
    const store = createSaveStore();
    store.set(currentWorkflowNameAtom, "Original");

    const firstRename = store.set(renameWorkflowAtom, "First");
    await waitForCalls(1);
    const secondRename = store.set(renameWorkflowAtom, "Second");

    pending.shift()?.reject(new Error("first name refused"));
    await waitForCalls(2);
    pending.shift()?.reject(new Error("second name refused"));
    await Promise.all([firstRename, secondRename]);

    expect(store.get(currentWorkflowNameAtom)).toBe("Original");
  });

  it("keeps a refused name out of a graph edit queued while the queue was already sending", async () => {
    const store = createSaveStore();
    store.set(autosaveDelayAtom, 0);
    store.set(currentWorkflowNameAtom, "Appointment reminders");

    const graphInFlight = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode("node_1")], edges: [] },
      { immediate: true }
    );
    const rename = store.set(renameWorkflowAtom, "Onboarding drip");
    pending.shift()?.resolve({
      ...savedWorkflow("workflow_1"),
      name: "Appointment reminders",
    });
    await waitForCalls(2);

    const laterEdit = store.set(saveWorkflowAtom, {
      nodes: [actionNode("node_2")],
      edges: [],
    });
    pending
      .shift()
      ?.reject(new Error('Workflow name "Onboarding drip" already exists'));
    await waitForCalls(3);
    pending.shift()?.resolve(savedWorkflow("workflow_1"));
    await Promise.all([graphInFlight, rename, laterEdit]);

    expect(updateMock.mock.calls[2]?.[1]).toMatchObject({
      nodes: [expect.objectContaining({ id: "node_2" })],
    });
    expect(updateMock.mock.calls[2]?.[1]).not.toHaveProperty("name");
    expect(store.get(currentWorkflowNameAtom)).toBe("Appointment reminders");
  });

  it("does not let an older identical request roll back a newer success", async () => {
    const store = createSaveStore();
    store.set(currentWorkflowNameAtom, "Original");

    const firstRename = store.set(renameWorkflowAtom, "Same");
    await waitForCalls(1);
    const secondRename = store.set(renameWorkflowAtom, "Same");

    pending.shift()?.reject(new Error("first request refused"));
    await waitForCalls(2);
    pending.shift()?.resolve({
      ...savedWorkflow("workflow_1"),
      name: "Same",
    });
    await Promise.all([firstRename, secondRename]);

    expect(store.get(currentWorkflowNameAtom)).toBe("Same");
  });
});
