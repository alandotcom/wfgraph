/**
 * A route that asks for the review sheet, such as a link to the Changes view
 * the editor once had, opens it once the workflow has settled, and never
 * meets a check still running.
 */

import { act, waitFor } from "@testing-library/react";
import { useAtomValue } from "jotai";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowActions } from "#src/components/workflow/workflow-toolbar-handlers";
import { useWorkflowToolbarState } from "#src/components/workflow/workflow-toolbar-state";
import {
  deferred,
  expectedSnapshot,
  graph,
  nodes,
  renderProbe,
  testQueryClient,
  workflowId,
  workflowStore,
} from "#src/components/workflow/workflow-toolbar-test-support";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { PREFLIGHT_BUSY_MESSAGE } from "#src/hooks/use-workflow-issue-preflight";
import {
  extractRpcProcedurePath,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import { loadWorkflowGraphAtom } from "#src/lib/workflow-graph-store";
import {
  beginPublicationReviewAtom,
  publicationReviewAtom,
} from "#src/lib/workflow-publication-review-store";
import { requestedReviewAtom } from "#src/lib/workflow-review-store";
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";
import type { WorkflowApiPayload } from "@wfgraph/shared/graph/api-contracts";
import { useRequestedReview } from "./use-requested-review";

const workflow: WorkflowApiPayload = {
  id: workflowId,
  name: "Workflow",
  graph,
  draftRevision: 1,
  isPaused: false,
  mode: "test",
  visibility: "private",
  createdAt: "2026-08-23T15:00:00.000Z",
  updatedAt: "2026-08-23T15:30:00.000Z",
  hasUnpublishedChanges: true,
  publishedVersionId: "version_7",
  publishedVersion: 7,
  publishedAt: "2026-08-23T15:00:00.000Z",
};

/** The toolbar's state, actions and route request, as the editor wires them. */
function RequestProbe() {
  const state = useWorkflowToolbarState();
  const actions = useWorkflowActions(state);
  useRequestedReview(state, actions);
  const review = useAtomValue(publicationReviewAtom);
  return <output>{review ? "ready" : "idle"}</output>;
}

/**
 * Answers the save and the comparison, holds the workflow read until the test
 * releases it, and leaves every other read pending.
 */
function stubServer() {
  const requests: string[] = [];
  const workflowRead = deferred<Response>();
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (url: RequestInfo | URL) => {
      const path = extractRpcProcedurePath(rpcUrl(url));
      requests.push(path);
      if (path === "workflow/getById") return workflowRead.promise;
      if (path === "workflow/update") {
        return rpcJsonResponse({ ...workflow, draftRevision: 2 });
      }
      if (path === "workflow/compareVersion") {
        return rpcJsonResponse({
          baseVersion: {
            id: "version_7",
            version: 7,
            publishedAt: "2026-08-23T15:00:00.000Z",
            isCurrent: true,
          },
          proposedVersion: 8,
          baseGraph: expectedSnapshot,
          draftGraph: expectedSnapshot,
          hasChanges: true,
          nodeChanges: [],
          edgeChanges: [],
        });
      }
      return new Promise<Response>(() => undefined);
    }
  );
  return {
    requests,
    releaseWorkflow: () => workflowRead.resolve(rpcJsonResponse(workflow)),
  };
}

beforeEach(() => {
  installAuthorizationGrantsForTests(WfGraphOperationIds);
});

afterEach(() => {
  resetAuthorizationGrantsForTests();
  vi.restoreAllMocks();
});

describe("useRequestedReview", () => {
  it("waits for the workflow read that resolves after the first render, then opens the review once", async () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "");
    const server = stubServer();
    const store = workflowStore();
    store.set(loadWorkflowGraphAtom, { nodes, edges: [] });
    store.set(requestedReviewAtom, workflowId);

    const view = renderProbe({
      probe: <RequestProbe />,
      store,
      queryClient: testQueryClient(),
    });
    await waitFor(() => expect(server.requests).toContain("workflow/getById"));
    // Nothing starts while the publication is still being read.
    expect(server.requests).not.toContain("workflow/update");
    expect(store.get(requestedReviewAtom)).toBe(workflowId);

    await act(async () => server.releaseWorkflow());

    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    expect(
      server.requests.filter((path) => path === "workflow/compareVersion")
    ).toHaveLength(1);
    expect(store.get(requestedReviewAtom)).toBeNull();
    expect(info).not.toHaveBeenCalledWith(
      PREFLIGHT_BUSY_MESSAGE,
      expect.anything()
    );
  });

  it("lets a review already being prepared answer the request, with no toast", async () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "");
    const server = stubServer();
    const store = workflowStore();
    store.set(loadWorkflowGraphAtom, { nodes, edges: [] });
    store.set(beginPublicationReviewAtom, workflowId);
    store.set(requestedReviewAtom, workflowId);

    renderProbe({
      probe: <RequestProbe />,
      store,
      queryClient: testQueryClient(),
    });
    await act(async () => server.releaseWorkflow());

    await waitFor(() => expect(store.get(requestedReviewAtom)).toBeNull());
    expect(server.requests).not.toContain("workflow/compareVersion");
    expect(info).not.toHaveBeenCalled();
  });
});
