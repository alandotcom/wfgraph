/**
 * What the editor does with a published run the server refused as stale.
 *
 * The toolbar builds the run request from the published version it has cached
 * and from the Published mode atom, so a refusal that leaves both in place
 * would make every later press send the same refused request. These cases hold
 * the recovery to reading the workflow back.
 */

import { fireEvent, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import type { RunRequest } from "#src/components/overlays/run-overlay";
import {
  useWorkflowActions,
  type WorkflowToolbarState,
} from "#src/components/workflow/workflow-toolbar-handlers";
import {
  expectedSnapshot,
  graph,
  renderProbe,
  state,
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
import { currentWorkflowModeAtom } from "#src/lib/workflow-save-store";

const STALE_MESSAGE =
  "The published version or the Published mode changed. Start the run again.";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Runs the published version and confirms the overlay the way its confirm
 * button would. `openOverlay` puts the exact `onRun` callback on the stack, so
 * the overlay UI itself stays out of this file.
 */
function PublishedRunProbe({
  workflowState,
}: {
  workflowState: WorkflowToolbarState;
}) {
  const actions = useWorkflowActions(workflowState);
  const { stack } = useOverlay();
  const top = stack.at(-1) as
    | { props: { onRun?: (request: RunRequest) => void } }
    | undefined;
  const onRun = top?.props.onRun;

  return (
    <>
      <button
        onClick={() => void actions.handleExecute("published")}
        type="button"
      >
        Run published
      </button>
      <button
        disabled={!onRun}
        onClick={() => onRun?.({ input: {} })}
        type="button"
      >
        Confirm run
      </button>
    </>
  );
}

/**
 * The workflow as it stands after someone else published v8 and switched
 * Published mode to Live, which is what the read after the refusal returns.
 */
function movedWorkflowPayload() {
  return {
    id: workflowId,
    name: "Workflow",
    graph,
    isPaused: false,
    mode: "live",
    visibility: "private",
    createdAt: "2026-08-23T15:00:00.000Z",
    updatedAt: "2026-08-23T15:30:00.000Z",
    hasUnpublishedChanges: false,
    publishedVersionId: "version_8",
    publishedVersion: 8,
    publishedAt: "2026-08-23T15:30:00.000Z",
  };
}

/** Answers the version graph the overlay reads, then refuses the run. */
function serveRefusedRun() {
  const requests: Array<{ path: string; input: unknown }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = extractRpcProcedurePath(rpcUrl(url));
      requests.push({ path, input: await parseRpcRequestInput(init) });
      if (path === "workflow/getVersionGraph") {
        return rpcJsonResponse({ graph: expectedSnapshot });
      }
      if (path === "workflow/execute") {
        return rpcErrorResponse({
          code: "CONFLICT",
          status: 409,
          message: STALE_MESSAGE,
          data: { error: STALE_MESSAGE },
        });
      }
      if (path === "workflow/getById") {
        return rpcJsonResponse(movedWorkflowPayload());
      }
      throw new Error(`Unexpected RPC procedure: ${path}`);
    }
  );
  return requests;
}

async function runPublishedVersion() {
  const store = workflowStore();
  store.set(currentWorkflowModeAtom, "test");
  const requests = serveRefusedRun();
  const errorToast = vi.spyOn(toast, "error");
  const view = renderProbe({
    probe: <PublishedRunProbe workflowState={state()} />,
    store,
    queryClient: testQueryClient(),
  });

  fireEvent.click(await view.findByRole("button", { name: "Run published" }));
  await waitFor(() => {
    expect(
      (view.getByRole("button", { name: "Confirm run" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });
  fireEvent.click(view.getByRole("button", { name: "Confirm run" }));

  return { errorToast, requests, store };
}

describe("a published run the server refused as stale", () => {
  it("reads the workflow back so the next press sends the current version", async () => {
    const { requests } = await runPublishedVersion();

    // The refused request repeats what the run dialog displayed.
    await waitFor(() => {
      expect(
        requests.some((request) => request.path === "workflow/execute")
      ).toBe(true);
    });
    const run = requests.find((request) => request.path === "workflow/execute");
    expect(run?.input).toMatchObject({
      expected: { versionId: "version_7", mode: "test" },
    });

    await waitFor(() => {
      expect(
        requests.some((request) => request.path === "workflow/getById")
      ).toBe(true);
    });
  });

  it("re-seeds Published mode from what came back", async () => {
    const { store } = await runPublishedVersion();

    await waitFor(() => {
      expect(store.get(currentWorkflowModeAtom)).toBe("live");
    });
  });

  it("says what the server said", async () => {
    const { errorToast } = await runPublishedVersion();

    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith(STALE_MESSAGE);
    });
  });
});
