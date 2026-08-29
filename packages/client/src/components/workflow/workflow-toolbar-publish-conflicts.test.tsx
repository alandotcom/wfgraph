/**
 * What the editor does with a publish the server refused.
 *
 * The two coded refusals each get their own recovery, chosen by the code on the
 * failure rather than by its sentence. Everything else keeps the one behaviour
 * a failed write has always had: the mutation cache says what the server said,
 * the review stays where it is, and the operator decides.
 */

import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useWorkflowActions,
  useWorkflowState,
} from "#src/components/workflow/workflow-toolbar-handlers";
import {
  deferred,
  expectedSnapshot,
  graph,
  nodes,
  PublishProbe,
  renderProbe,
  testQueryClient,
  workflowId,
  workflowStore,
} from "#src/components/workflow/workflow-toolbar-test-support";
import {
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcErrorResponse,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowApiPayload } from "@wfgraph/shared/graph/api-contracts";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { PUBLICATION_CONFLICT_CODES } from "@wfgraph/shared/rpc/error-codes";

const STALE_PUBLISH_MESSAGE =
  "This workflow was published elsewhere. Refresh and try again.";
const ALREADY_PUBLISHED_MESSAGE = "This workflow graph is already published.";

const workflowEntryKey = orpcQuery.workflow.getById.queryKey({
  input: { workflowId },
});
const versionHistoryKey = orpcQuery.workflow.getVersionHistory.infiniteKey({
  input: (cursor: undefined) => ({ workflowId, cursor }),
  initialPageParam: undefined,
});

/** The open workflow as the loader left it in the cache. */
function workflowPayload(publishedVersionId = "version_7"): WorkflowApiPayload {
  return {
    id: workflowId,
    name: "Workflow",
    graph,
    isPaused: false,
    mode: "test",
    visibility: "private",
    createdAt: "2026-08-23T15:00:00.000Z",
    updatedAt: "2026-08-23T15:30:00.000Z",
    hasUnpublishedChanges: true,
    publishedVersionId,
    publishedVersion: Number(publishedVersionId.split("_")[1]),
    publishedAt: "2026-08-23T15:00:00.000Z",
  };
}

function seedWorkflowEntry(queryClient: QueryClient) {
  queryClient.setQueryData(workflowEntryKey, workflowPayload());
  queryClient.setQueryData(versionHistoryKey, {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  });
}

function comparisonResponse(baseVersionId = "version_7"): Response {
  return rpcJsonResponse({
    baseVersion: {
      id: baseVersionId,
      version: Number(baseVersionId.split("_")[1]),
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

function conflictResponse(code: string, message: string): Response {
  return rpcErrorResponse({
    code: "CONFLICT",
    status: 409,
    message,
    data: { error: message, code },
  });
}

/** Answers the comparison, then hands the publish attempt whatever is given. */
function stubPublishFlow(publishAnswer: () => Response | Promise<Response>) {
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (url: RequestInfo | URL) => {
      const path = extractRpcProcedurePath(rpcUrl(url));
      requests.push(path);
      if (path === "workflow/compareVersion") {
        return comparisonResponse();
      }
      if (path === "workflow/publish") {
        return publishAnswer();
      }
      throw new Error(`Unexpected RPC procedure: ${path}`);
    }
  );
  return requests;
}

/**
 * The toolbar as the editor assembles it, with its state read from the store
 * and the query cache rather than handed in.
 *
 * A recovery that re-reads the workflow is only worth anything if the next
 * attempt is built from what came back, so the suite that checks that has to
 * render the real read.
 */
function LivePublishProbe() {
  const workflowState = useWorkflowState();
  const actions = useWorkflowActions(workflowState);
  return (
    <>
      <button onClick={actions.handlePublish} type="button">
        Start publish
      </button>
      <button onClick={actions.confirmPublish} type="button">
        Confirm publish
      </button>
      <output>{actions.publishReview ? "ready" : "idle"}</output>
    </>
  );
}

/** A probe the operator can leave, taking the review's own handlers with it. */
function LeavablePublishProbe() {
  const [inEditor, setInEditor] = useState(true);
  return (
    <>
      <button onClick={() => setInEditor(false)} type="button">
        Leave editor
      </button>
      {inEditor && <PublishProbe />}
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useWorkflowActions publication conflicts", () => {
  it("ends the review and reloads publication state after a stale publish", async () => {
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "");
    const requests = stubPublishFlow(() =>
      conflictResponse(PUBLICATION_CONFLICT_CODES.stale, STALE_PUBLISH_MESSAGE)
    );
    const queryClient = testQueryClient();
    seedWorkflowEntry(queryClient);
    const store = workflowStore();
    store.set(loadWorkflowGraphAtom, { nodes, edges: [] });
    const draft = store.get(nodesAtom);

    const view = renderProbe({ queryClient, store });
    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Confirm publish" }));

    await waitFor(() => expect(view.getByText("idle")).toBeTruthy());
    // The canvas keeps the graph the operator has been editing. Recovery reads
    // the workflow again for its publication fields; nothing re-seeds the draft.
    expect(store.get(nodesAtom)).toBe(draft);
    expect(queryClient.getQueryState(workflowEntryKey)?.isInvalidated).toBe(
      true
    );
    expect(queryClient.getQueryState(versionHistoryKey)?.isInvalidated).toBe(
      true
    );
    // One attempt. A publish the operator has not reviewed again is never sent.
    expect(requests).toEqual(["workflow/compareVersion", "workflow/publish"]);
    expect(errorToast).toHaveBeenCalledTimes(1);
    expect(errorToast).toHaveBeenCalledWith(
      "Someone published a newer version while you were reviewing. Publish again to compare against it."
    );
  });

  // The point of re-reading the workflow is the version the next attempt names.
  // Reading it off the state the first attempt closed over would send the
  // operator back into the same refusal.
  it("compares against the version the recovery read back", async () => {
    vi.spyOn(toast, "error").mockImplementation(() => "");
    const requests: Array<{ path: string; input: JsonObject }> = [];
    let currentVersionId = "version_7";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = extractRpcProcedurePath(rpcUrl(url));
        const input = await parseRpcRequestInput(init);
        requests.push({ path, input });

        switch (path) {
          case "workflow/getAll":
          case "integration/getAll":
            return rpcJsonResponse([]);
          case "workflow/getById":
            return rpcJsonResponse(workflowPayload(currentVersionId));
          case "workflow/compareVersion":
            return comparisonResponse(currentVersionId);
          case "workflow/publish":
            // Publishing is what discovers that someone got there first, and
            // the workflow reads back at that newer version from here on.
            currentVersionId = "version_9";
            return conflictResponse(
              PUBLICATION_CONFLICT_CODES.stale,
              STALE_PUBLISH_MESSAGE
            );
          default:
            throw new Error(`Unexpected RPC procedure: ${path}`);
        }
      }
    );
    const queryClient = testQueryClient();
    seedWorkflowEntry(queryClient);
    const store = workflowStore();
    store.set(loadWorkflowGraphAtom, { nodes, edges: [] });

    const view = renderProbe({
      probe: <LivePublishProbe />,
      queryClient,
      store,
    });
    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Confirm publish" }));
    await waitFor(() => expect(view.getByText("idle")).toBeTruthy());
    await waitFor(() =>
      expect(queryClient.getQueryData(workflowEntryKey)).toMatchObject({
        publishedVersionId: "version_9",
      })
    );

    fireEvent.click(view.getByRole("button", { name: "Start publish" }));
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());

    const comparisons = requests.filter(
      (request) => request.path === "workflow/compareVersion"
    );
    expect(comparisons).toHaveLength(2);
    expect(comparisons[1]?.input.baseVersionId).toBe("version_9");
  });

  it("closes the review and reports nothing to publish", async () => {
    const infoToast = vi.spyOn(toast, "info").mockImplementation(() => "");
    stubPublishFlow(() =>
      conflictResponse(
        PUBLICATION_CONFLICT_CODES.alreadyPublished,
        ALREADY_PUBLISHED_MESSAGE
      )
    );
    const queryClient = testQueryClient();
    seedWorkflowEntry(queryClient);

    const view = renderProbe({ queryClient });
    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Confirm publish" }));

    await waitFor(() => expect(view.getByText("idle")).toBeTruthy());
    expect(infoToast).toHaveBeenCalledWith("No changes to publish");
    expect(queryClient.getQueryData(workflowEntryKey)).toMatchObject({
      hasUnpublishedChanges: false,
    });
  });

  it("ignores a stale refusal that lost its review while in flight", async () => {
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "");
    const publish = deferred<Response>();
    stubPublishFlow(() => publish.promise);
    const queryClient = testQueryClient();
    seedWorkflowEntry(queryClient);

    const view = renderProbe({ queryClient });
    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Confirm publish" }));
    // Cancelling advances the review's epoch, so the answer below belongs to a
    // review nobody is waiting on any more.
    fireEvent.click(view.getByRole("button", { name: "Cancel review" }));

    await act(async () => {
      publish.resolve(
        conflictResponse(
          PUBLICATION_CONFLICT_CODES.stale,
          STALE_PUBLISH_MESSAGE
        )
      );
    });

    expect(errorToast).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(workflowEntryKey)?.isInvalidated).toBe(
      false
    );
  });

  it("ignores an already-published refusal that lost its review while in flight", async () => {
    const infoToast = vi.spyOn(toast, "info").mockImplementation(() => "");
    const publish = deferred<Response>();
    stubPublishFlow(() => publish.promise);
    const queryClient = testQueryClient();
    seedWorkflowEntry(queryClient);

    const view = renderProbe({ queryClient });
    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Confirm publish" }));
    fireEvent.click(view.getByRole("button", { name: "Cancel review" }));

    await act(async () => {
      publish.resolve(
        conflictResponse(
          PUBLICATION_CONFLICT_CODES.alreadyPublished,
          ALREADY_PUBLISHED_MESSAGE
        )
      );
    });

    expect(infoToast).not.toHaveBeenCalled();
    // The badge belongs to whatever the operator is reviewing now, so a refusal
    // this old writes nothing into it.
    expect(queryClient.getQueryData(workflowEntryKey)).toMatchObject({
      hasUnpublishedChanges: true,
    });
  });

  it("keeps the review open and says what the server said for any other failure", async () => {
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "");
    stubPublishFlow(() =>
      rpcErrorResponse({
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
        message: "Failed to publish workflow",
        data: { error: "Failed to publish workflow" },
      })
    );
    const queryClient = testQueryClient();
    seedWorkflowEntry(queryClient);

    const view = renderProbe({ queryClient });
    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Confirm publish" }));

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith("Failed to publish workflow")
    );
    expect(view.getByText("ready")).toBeTruthy();
    expect(queryClient.getQueryState(workflowEntryKey)?.isInvalidated).toBe(
      false
    );
  });

  // A code this build has never heard of is not one of the two recoveries, so
  // it takes the same path as an uncoded failure.
  it("treats an unrecognised code as any other failure", async () => {
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "");
    stubPublishFlow(() =>
      conflictResponse("workflow_publish_embargoed", "Publishing is paused.")
    );
    const queryClient = testQueryClient();
    seedWorkflowEntry(queryClient);

    const view = renderProbe({ queryClient });
    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Confirm publish" }));

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith("Publishing is paused.")
    );
    expect(view.getByText("ready")).toBeTruthy();
    expect(queryClient.getQueryData(workflowEntryKey)).toMatchObject({
      hasUnpublishedChanges: true,
    });
  });

  // The mutation cache is what carries a generic failure, because a per-mutate
  // onError is skipped once the component that called mutate has unmounted. A
  // publish that claimed every failure for itself would be silent here.
  it("still says what the server said after the operator has left the editor", async () => {
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "");
    const publish = deferred<Response>();
    stubPublishFlow(() => publish.promise);
    const queryClient = testQueryClient();
    seedWorkflowEntry(queryClient);

    const view = renderProbe({
      probe: <LeavablePublishProbe />,
      queryClient,
    });
    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Confirm publish" }));
    fireEvent.click(view.getByRole("button", { name: "Leave editor" }));

    await act(async () => {
      publish.resolve(
        rpcErrorResponse({
          code: "INTERNAL_SERVER_ERROR",
          status: 500,
          message: "Failed to publish workflow",
          data: { error: "Failed to publish workflow" },
        })
      );
    });

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith("Failed to publish workflow")
    );
  });
});
