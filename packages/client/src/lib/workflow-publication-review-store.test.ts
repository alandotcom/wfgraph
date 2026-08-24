import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  canvasEditingLockedAtom,
  hydrateWorkflowAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  onNodesChangeAtom,
} from "#src/lib/workflow-graph-store";
import {
  beginPublicationReviewAtom,
  clearPublicationReviewAtom,
  installPublicationReviewAtom,
  isPublicationReviewActiveAtom,
  isPublicationReviewPendingAtom,
  publicationReviewAtom,
  settlePublicationReviewAtom,
} from "#src/lib/workflow-publication-review-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { savedWorkflow } from "./workflow-save-test-support";

const graph = createSerializedWorkflowGraph({ nodes: [], edges: [] });

describe("publication review store", () => {
  it("locks draft writes from compare start through confirmation and unlocks after cancellation", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(loadWorkflowGraphAtom, {
      nodes: [
        {
          id: "node_1",
          type: "action",
          position: { x: 0, y: 0 },
          data: { label: "Action", type: "action" },
        },
      ],
      edges: [],
    });

    const epoch = store.set(beginPublicationReviewAtom, "workflow_1");
    expect(store.get(isPublicationReviewPendingAtom)).toBe(true);
    expect(store.get(canvasEditingLockedAtom)).toBe(true);
    store.set(onNodesChangeAtom, [
      {
        type: "position",
        id: "node_1",
        dragging: false,
        position: { x: 100, y: 0 },
      },
    ]);
    expect(store.get(nodesAtom)[0]?.position).toEqual({ x: 0, y: 0 });

    store.set(installPublicationReviewAtom, {
      workflowId: "workflow_1",
      epoch: epoch ?? 0,
      pending: false,
      graph,
      expectedPublishedVersionId: null,
      review: {
        proposedVersion: 1,
        nodeChanges: [],
        edgeChanges: [],
      },
    });
    expect(store.get(isPublicationReviewPendingAtom)).toBe(false);
    expect(store.get(publicationReviewAtom)).toMatchObject({
      workflowId: "workflow_1",
      expectedPublishedVersionId: null,
    });
    expect(store.get(canvasEditingLockedAtom)).toBe(true);

    store.set(clearPublicationReviewAtom, "workflow_1");
    expect(store.get(canvasEditingLockedAtom)).toBe(false);
  });

  it("discards a late response after the editor opens a different workflow", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    const epoch = store.set(beginPublicationReviewAtom, "workflow_1");
    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_2"));

    store.set(installPublicationReviewAtom, {
      workflowId: "workflow_1",
      epoch: epoch ?? 0,
      pending: false,
      graph,
      expectedPublishedVersionId: "version_1",
      review: { proposedVersion: 2, nodeChanges: [], edgeChanges: [] },
    });

    expect(store.get(publicationReviewAtom)).toBeNull();
    expect(store.get(isPublicationReviewActiveAtom)).toBe(false);
    store.set(currentWorkflowIdAtom, "workflow_1");
    expect(store.get(publicationReviewAtom)).toBeNull();
  });

  it("clears the active preflight when workflow hydration starts a new lifetime", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(beginPublicationReviewAtom, "workflow_1");

    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_1"));

    expect(store.get(isPublicationReviewActiveAtom)).toBe(false);
  });

  it("rejects a deferred response after cancellation invalidates its epoch", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    const epoch = store.set(beginPublicationReviewAtom, "workflow_1");
    store.set(clearPublicationReviewAtom, "workflow_1");

    expect(
      store.set(installPublicationReviewAtom, {
        workflowId: "workflow_1",
        epoch: epoch ?? 0,
        pending: false,
        graph,
        expectedPublishedVersionId: null,
        review: { proposedVersion: 1, nodeChanges: [], edgeChanges: [] },
      })
    ).toBe(false);
    expect(store.get(publicationReviewAtom)).toBeNull();
  });

  it("rejects a deferred response after the same workflow hydrates again", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    const epoch = store.set(beginPublicationReviewAtom, "workflow_1");

    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_1"));

    expect(
      store.set(installPublicationReviewAtom, {
        workflowId: "workflow_1",
        epoch: epoch ?? 0,
        pending: false,
        graph,
        expectedPublishedVersionId: null,
        review: { proposedVersion: 1, nodeChanges: [], edgeChanges: [] },
      })
    ).toBe(false);
    expect(store.get(publicationReviewAtom)).toBeNull();
  });

  it("keeps a newer A request locked when the older A request settles after A to B to A", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_a");
    const firstEpoch = store.set(beginPublicationReviewAtom, "workflow_a");
    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_b"));
    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_a"));
    const secondEpoch = store.set(beginPublicationReviewAtom, "workflow_a");

    expect(
      store.set(settlePublicationReviewAtom, {
        workflowId: "workflow_a",
        epoch: firstEpoch ?? 0,
      })
    ).toBe(false);
    expect(store.get(isPublicationReviewPendingAtom)).toBe(true);
    expect(
      store.set(installPublicationReviewAtom, {
        workflowId: "workflow_a",
        epoch: firstEpoch ?? 0,
        pending: false,
        graph,
        expectedPublishedVersionId: null,
        review: { proposedVersion: 1, nodeChanges: [], edgeChanges: [] },
      })
    ).toBe(false);
    store.set(settlePublicationReviewAtom, {
      workflowId: "workflow_a",
      epoch: secondEpoch ?? 0,
    });
    expect(store.get(isPublicationReviewPendingAtom)).toBe(false);
  });
});
