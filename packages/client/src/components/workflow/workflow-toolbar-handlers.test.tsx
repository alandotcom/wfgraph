/**
 * What Publish and Run do before they reach the server.
 *
 * The provider preflight is asynchronous and the operator can navigate away
 * while it runs, so most of what is checked here is which answers still count.
 * A publish the server refuses is `workflow-toolbar-publish-conflicts.test.tsx`.
 */

import { act, fireEvent, waitFor } from "@testing-library/react";
import { useSetAtom } from "jotai";
import { useState } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import type { TestRunRequest } from "#src/components/overlays/test-run-overlay";
import {
  useWorkflowActions,
  type WorkflowToolbarState,
} from "#src/components/workflow/workflow-toolbar-handlers";
import {
  deferred,
  expectedSnapshot,
  PublishProbe,
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
import { PREFLIGHT_BUSY_MESSAGE } from "#src/hooks/use-workflow-issue-preflight";
import { orpcQuery } from "#src/lib/rpc-query";
import { canvasEditingLockedAtom } from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { toEditorNode } from "#src/lib/workflow-graph-types";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const providerCatalog: ExtensionCatalog = {
  actions: [
    {
      id: "resend/send-email",
      label: "Send Email",
      description: "Sends an email",
      category: "Resend",
      integration: "resend",
      sideEffect: true,
      configFields: [
        {
          key: "emailTemplateId",
          label: "Template",
          type: "provider-select",
          optionsSource: { provider: "templates" },
        },
        {
          key: "emailTemplateVariables",
          label: "Template Variables",
          type: "provider-fields",
          optionsSource: {
            provider: "template-variables",
            parameters: ["emailTemplateId"],
          },
        },
      ],
      outputFields: [],
    },
  ],
  events: [],
  integrations: [],
};
const providerGraph = createSerializedWorkflowGraph({
  nodes: [
    {
      id: "lifecycle_1",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: { label: "Lifecycle", type: "lifecycle" },
    },
    {
      id: "action_1",
      type: "action",
      position: { x: 0, y: 180 },
      data: {
        label: "Send Email",
        type: "action",
        config: {
          actionType: "resend/send-email",
          integrationId: "int_1",
          emailTemplateId: "tpl_1",
        },
      },
    },
  ],
  edges: [],
});
const providerNodes =
  toWorkflowGraphData(providerGraph).nodes.map(toEditorNode);

function providerState(
  currentWorkflowId = workflowId,
  templateId = "tpl_1"
): WorkflowToolbarState {
  return {
    ...state(),
    currentWorkflowId,
    nodes: providerNodes.map((node) =>
      node.data.type === "action"
        ? {
            ...node,
            data: {
              ...node.data,
              config: {
                ...node.data.config,
                emailTemplateId: templateId,
              },
            },
          }
        : node
    ),
    userIntegrations: [
      {
        id: "int_1",
        name: "Resend",
        type: "resend",
        createdAt: "2026-08-23T15:00:00.000Z",
        updatedAt: "2026-08-23T15:00:00.000Z",
        configuredKeys: [],
      },
    ],
  };
}

function NavigationPublishProbe({
  initialState = state(),
  nextState,
}: {
  initialState?: WorkflowToolbarState;
  nextState?: WorkflowToolbarState;
}) {
  const [workflowState, setWorkflowState] = useState(initialState);
  const setCurrentWorkflowId = useSetAtom(currentWorkflowIdAtom);
  const destinationState = nextState ?? {
    ...initialState,
    currentWorkflowId: "workflow_2",
  };

  return (
    <>
      <button
        onClick={() => {
          setCurrentWorkflowId(destinationState.currentWorkflowId);
          setWorkflowState(destinationState);
        }}
        type="button"
      >
        Open workflow 2
      </button>
      <PublishProbe workflowState={workflowState} />
    </>
  );
}

function UnmountPublishProbe() {
  const [showWorkflow, setShowWorkflow] = useState(true);
  const { stack } = useOverlay();

  return (
    <>
      <button onClick={() => setShowWorkflow(false)} type="button">
        Leave workflow
      </button>
      {showWorkflow && <PublishProbe workflowState={providerState()} />}
      <output aria-label="persistent overlay count">{stack.length}</output>
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Confirms the Test Run overlay the way the overlay's own "Run" button would,
 * without rendering the overlay's UI: `openOverlay` already packaged the exact
 * `onRun` callback that button calls, on the stack `useOverlay` exposes.
 */
function RunGraphProbe({
  workflowState,
}: {
  workflowState: WorkflowToolbarState;
}) {
  const actions = useWorkflowActions(workflowState);
  const { stack } = useOverlay();
  const top = stack.at(-1) as
    | { props: { onRun?: (request: TestRunRequest) => void } }
    | undefined;
  const onRun = top?.props.onRun;

  return (
    <>
      <button onClick={() => void actions.handleExecute()} type="button">
        Run workflow
      </button>
      <button
        disabled={!onRun}
        onClick={() => onRun?.({ input: {} })}
        type="button"
      >
        Confirm test run
      </button>
    </>
  );
}

/**
 * What a save answers with, which is where a test run now takes its
 * draft-or-published decision from. The two publication fields are the whole
 * point; the rest is the payload shape `toSavedWorkflow` decodes.
 */
function savedWorkflowResponse(publication: {
  hasUnpublishedChanges: boolean;
  publishedVersionId?: string;
}) {
  return {
    id: workflowId,
    name: "Workflow",
    graph: expectedSnapshot,
    isPaused: false,
    mode: "test",
    visibility: "private",
    createdAt: "2026-08-23T15:00:00.000Z",
    updatedAt: "2026-08-23T15:05:00.000Z",
    ...publication,
  };
}

/**
 * Answers the two calls a test run makes, in order: the flush of the canvas,
 * then the run itself. Returns the recorded requests, so a case can say both
 * that the canvas was sent and what the run asked for.
 */
function serveRunRequests(options: {
  saved?: Parameters<typeof savedWorkflowResponse>[0];
  saveFails?: boolean;
  runMode?: string;
}) {
  const requests: Array<{ path: string; input: unknown }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = extractRpcProcedurePath(rpcUrl(url));
      const input = await parseRpcRequestInput(init);
      requests.push({ path, input });
      if (path === "workflow/update") {
        if (options.saveFails) {
          return rpcErrorResponse({
            code: "INTERNAL_SERVER_ERROR",
            status: 500,
            message: "Database is away",
          });
        }
        return rpcJsonResponse(
          savedWorkflowResponse(
            options.saved ?? { hasUnpublishedChanges: true }
          )
        );
      }
      if (path === "workflow/execute") {
        return rpcJsonResponse({
          status: "running",
          executionId: "exec_1",
          runMode: options.runMode ?? "test",
        });
      }
      throw new Error(`Unexpected RPC procedure: ${path}`);
    }
  );
  return requests;
}

/** Open the Test Run overlay and confirm it, which is one full Run click. */
async function confirmRun(view: ReturnType<typeof renderProbe>) {
  fireEvent.click(await view.findByRole("button", { name: "Run workflow" }));
  await waitFor(() =>
    expect(
      (
        view.getByRole("button", {
          name: "Confirm test run",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  );
  fireEvent.click(view.getByRole("button", { name: "Confirm test run" }));
}

describe("useWorkflowActions Run graph selection", () => {
  it("runs the draft when a test-mode workflow has unpublished changes", async () => {
    const requests = serveRunRequests({
      saved: { hasUnpublishedChanges: true, publishedVersionId: "version_7" },
    });

    const view = renderProbe({
      // Default fixture state: test mode, published, with unpublished changes.
      probe: <RunGraphProbe workflowState={state()} />,
    });

    await confirmRun(view);

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]?.path).toBe("workflow/update");
    expect(requests[1]).toEqual({
      path: "workflow/execute",
      input: { workflowId, input: {}, graph: "draft" },
    });
  });

  it("runs the draft in test mode when the workflow has never been published", async () => {
    const requests = serveRunRequests({
      saved: { hasUnpublishedChanges: false },
    });

    const neverPublished = {
      ...state(),
      publication: { isPublished: false, hasUnpublishedChanges: false },
    };
    const view = renderProbe({
      probe: <RunGraphProbe workflowState={neverPublished} />,
    });

    await confirmRun(view);

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.input).toEqual({
      workflowId,
      input: {},
      graph: "draft",
    });
  });

  it("sends the canvas before the run, and decides on what that save answered", async () => {
    // The rendered signal still says the draft is ahead of published; the save
    // that lands first says it no longer is, and that is the reading the run
    // takes. Reversed, this is the hazard the flush exists for: a fresh edit
    // whose save has not landed would otherwise run the published graph.
    const requests = serveRunRequests({
      saved: { hasUnpublishedChanges: false, publishedVersionId: "version_7" },
    });

    const view = renderProbe({
      probe: <RunGraphProbe workflowState={state()} />,
    });

    await confirmRun(view);

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]).toEqual({
      path: "workflow/update",
      input: { workflowId, graph: expectedSnapshot },
    });
    // No `graph` key at all: absent means published, on the wire as elsewhere.
    expect(requests[1]).toEqual({
      path: "workflow/execute",
      input: { workflowId, input: {} },
    });
  });

  it("refuses to start a run the canvas could not be saved for", async () => {
    const errorToast = vi.spyOn(toast, "error");
    const requests = serveRunRequests({ saveFails: true });

    const view = renderProbe({
      probe: <RunGraphProbe workflowState={state()} />,
    });

    await confirmRun(view);

    await waitFor(() => expect(errorToast).toHaveBeenCalled());
    // Only the refused save: running here would execute the graph the server
    // last accepted while the canvas paints statuses on the newer one.
    expect(requests.map((request) => request.path)).toEqual([
      "workflow/update",
    ]);
  });

  it("starts a clean canvas straight away, with no save of its own", async () => {
    const requests = serveRunRequests({});

    const saved = {
      ...state(),
      hasUnsavedChanges: false,
      publication: { isPublished: true, hasUnpublishedChanges: false },
    };
    const view = renderProbe({
      probe: <RunGraphProbe workflowState={saved} />,
    });

    await confirmRun(view);

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({
      path: "workflow/execute",
      input: { workflowId, input: {} },
    });
  });

  it("runs the published graph for a live workflow even with unpublished changes", async () => {
    const requests = serveRunRequests({ runMode: "live" });

    const live = { ...state(), workflowMode: "live" as const };
    const view = renderProbe({ probe: <RunGraphProbe workflowState={live} /> });

    await confirmRun(view);

    // A live workflow's draft is never what runs, so nothing is flushed either.
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({
      path: "workflow/execute",
      input: { workflowId, input: {} },
    });
  });
});

describe("useWorkflowActions publication preflight", () => {
  it("waits for the same provider preflight before opening a test run", async () => {
    const answer = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url: RequestInfo | URL) => {
        const path = extractRpcProcedurePath(rpcUrl(url));
        if (path === "integration/configOptions") {
          return answer.promise;
        }
        throw new Error(`Unexpected RPC procedure: ${path}`);
      }
    );
    const view = renderProbe({
      probe: <PublishProbe workflowState={providerState()} />,
      extensionCatalog: providerCatalog,
      queryClient: testQueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
    });

    fireEvent.click(await view.findByRole("button", { name: "Run workflow" }));
    await waitFor(() =>
      expect(
        view.getByRole("status", { name: "provider preflight" }).textContent
      ).toBe("true")
    );
    expect(
      view.getByRole("status", { name: "overlay count" }).textContent
    ).toBe("0");

    await act(async () => {
      answer.resolve(rpcJsonResponse({ status: "fields", fields: [] }));
    });

    await waitFor(() =>
      expect(
        view.getByRole("status", { name: "overlay count" }).textContent
      ).toBe("1")
    );
  });

  it("discards a Run preflight after navigating to another workflow", async () => {
    const firstAnswer = deferred<Response>();
    const secondAnswer = deferred<Response>();
    let requestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url: RequestInfo | URL) => {
        const path = extractRpcProcedurePath(rpcUrl(url));
        if (path === "integration/configOptions") {
          requestCount += 1;
          return requestCount === 1
            ? firstAnswer.promise
            : secondAnswer.promise;
        }
        throw new Error(`Unexpected RPC procedure: ${path}`);
      }
    );
    const view = renderProbe({
      probe: (
        <NavigationPublishProbe
          initialState={providerState()}
          nextState={providerState("workflow_2", "tpl_2")}
        />
      ),
      extensionCatalog: providerCatalog,
    });

    fireEvent.click(await view.findByRole("button", { name: "Run workflow" }));
    await waitFor(() =>
      expect(
        view.getByRole("status", { name: "provider preflight" }).textContent
      ).toBe("true")
    );
    fireEvent.click(view.getByRole("button", { name: "Open workflow 2" }));

    await waitFor(() =>
      expect(
        view.getByRole("status", { name: "provider preflight" }).textContent
      ).toBe("false")
    );
    expect(
      view.getByRole("status", { name: "overlay count" }).textContent
    ).toBe("0");

    fireEvent.click(view.getByRole("button", { name: "Run workflow" }));
    await waitFor(() => expect(requestCount).toBe(2));
    expect(
      view.getByRole("status", { name: "provider preflight" }).textContent
    ).toBe("true");

    await act(async () => {
      firstAnswer.resolve(rpcJsonResponse({ status: "fields", fields: [] }));
    });

    expect(
      view.getByRole("status", { name: "overlay count" }).textContent
    ).toBe("0");
    expect(
      view.getByRole("status", { name: "provider preflight" }).textContent
    ).toBe("true");

    await act(async () => {
      secondAnswer.resolve(rpcJsonResponse({ status: "fields", fields: [] }));
    });
    await waitFor(() =>
      expect(
        view.getByRole("status", { name: "overlay count" }).textContent
      ).toBe("1")
    );
  });

  it("does not begin preflight from an already-stale workflow handler", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const view = renderProbe({
      probe: <PublishProbe workflowState={providerState()} />,
      extensionCatalog: providerCatalog,
      store: workflowStore("workflow_2"),
    });

    fireEvent.click(await view.findByRole("button", { name: "Run workflow" }));

    expect(fetch).not.toHaveBeenCalled();
    expect(
      view.getByRole("status", { name: "provider preflight" }).textContent
    ).toBe("false");
    expect(
      view.getByRole("status", { name: "overlay count" }).textContent
    ).toBe("0");
  });

  it("discards a Run preflight when the workflow UI unmounts", async () => {
    const answer = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url: RequestInfo | URL) => {
        const path = extractRpcProcedurePath(rpcUrl(url));
        if (path === "integration/configOptions") {
          return answer.promise;
        }
        throw new Error(`Unexpected RPC procedure: ${path}`);
      }
    );
    const view = renderProbe({
      probe: <UnmountPublishProbe />,
      extensionCatalog: providerCatalog,
    });

    fireEvent.click(await view.findByRole("button", { name: "Run workflow" }));
    await waitFor(() =>
      expect(
        view.getByRole("status", { name: "provider preflight" }).textContent
      ).toBe("true")
    );
    fireEvent.click(view.getByRole("button", { name: "Leave workflow" }));

    await act(async () => {
      answer.resolve(rpcJsonResponse({ status: "fields", fields: [] }));
    });

    expect(
      view.getByRole("status", { name: "persistent overlay count" }).textContent
    ).toBe("0");
  });

  it("waits for provider fields and blocks duplicate publish attempts", async () => {
    const answer = deferred<Response>();
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url: RequestInfo | URL) => {
        const path = extractRpcProcedurePath(rpcUrl(url));
        requests.push(path);
        if (path === "integration/configOptions") {
          return answer.promise;
        }
        throw new Error(`Unexpected RPC procedure: ${path}`);
      }
    );
    const view = renderProbe({
      probe: <PublishProbe workflowState={providerState()} />,
      extensionCatalog: providerCatalog,
      queryClient: testQueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
    });

    const infoToast = vi.spyOn(toast, "info").mockImplementation(() => "");
    const publish = await view.findByRole("button", { name: "Start publish" });
    fireEvent.click(publish);
    fireEvent.click(publish);
    await waitFor(() =>
      expect(requests).toEqual(["integration/configOptions"])
    );
    expect(view.getByText("idle")).toBeTruthy();
    // The second click is dropped, and says so. Cmd+Enter reaches this without
    // passing the command palette's disabled state, so a swallowed press would
    // otherwise look like a dead keyboard.
    expect(infoToast).toHaveBeenCalledWith(
      PREFLIGHT_BUSY_MESSAGE,
      expect.objectContaining({ id: expect.any(String) })
    );

    await act(async () => {
      answer.resolve(
        rpcJsonResponse({
          status: "fields",
          fields: [
            {
              key: "DONOR_FIRST_NAME",
              label: "DONOR_FIRST_NAME",
              required: true,
            },
          ],
        })
      );
    });

    await waitFor(() =>
      expect(
        view.getByRole("status", { name: "provider preflight" }).textContent
      ).toBe("false")
    );
    expect(view.getByText("idle")).toBeTruthy();
    expect(requests).toEqual(["integration/configOptions"]);
  });

  // A connection whose grant has expired refuses every provider question asked
  // of it. That used to reject the whole preflight, which put Publish behind a
  // toast nothing the operator did could clear.
  it("publishes past a provider-backed field it could not check", async () => {
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "");
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url: RequestInfo | URL) => {
        const path = extractRpcProcedurePath(rpcUrl(url));
        requests.push(path);
        if (path === "workflow/compareVersion") {
          return rpcJsonResponse({
            baseVersion: {
              id: "version_7",
              version: 7,
              publishedAt: "2026-08-23T15:00:00.000Z",
              isCurrent: true,
            },
            proposedVersion: 8,
            baseGraph: providerGraph,
            draftGraph: providerGraph,
            hasChanges: true,
            nodeChanges: [],
            edgeChanges: [],
          });
        }
        throw new Error("provider response contained credentials");
      }
    );
    const view = renderProbe({
      probe: <PublishProbe workflowState={providerState()} />,
      extensionCatalog: providerCatalog,
      queryClient: testQueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
    });

    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));

    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    expect(requests).toEqual([
      "integration/configOptions",
      "workflow/compareVersion",
    ]);
    expect(errorToast).not.toHaveBeenCalled();
    errorToast.mockRestore();
  });

  // The half of the list the graph can answer on its own is the half that names
  // the node to open, so a refused provider answer must not take it down too.
  it("still lists the graph's own issues when the provider refuses", async () => {
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("provider response contained credentials");
    });
    const unconnected = providerState();
    const view = renderProbe({
      probe: (
        <PublishProbe
          workflowState={{ ...unconnected, userIntegrations: [] }}
        />
      ),
      extensionCatalog: providerCatalog,
      queryClient: testQueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
    });

    fireEvent.click(await view.findByRole("button", { name: "Run workflow" }));

    // The overlay is what the refusal used to replace with a toast. Which rows
    // it draws is `use-provider-field-issues.test.tsx`.
    await waitFor(() =>
      expect(
        view.getByRole("status", { name: "overlay count" }).textContent
      ).toBe("1")
    );
    expect(errorToast).not.toHaveBeenCalled();
    errorToast.mockRestore();
  });

  it("compares the exact editor snapshot before confirmation publishes that snapshot", async () => {
    const requests: Array<{ path: string; input: unknown }> = [];
    const queryClient = testQueryClient();
    const versionHistoryKey = orpcQuery.workflow.getVersionHistory.infiniteKey({
      input: (cursor: undefined) => ({ workflowId, cursor }),
      initialPageParam: undefined,
    });
    queryClient.setQueryData(versionHistoryKey, {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = extractRpcProcedurePath(rpcUrl(url));
        const input = await parseRpcRequestInput(init);
        requests.push({ path, input });

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

        if (path === "workflow/publish") {
          return rpcJsonResponse({
            id: workflowId,
            name: "Workflow",
            graph: expectedSnapshot,
            isPaused: false,
            mode: "test",
            visibility: "private",
            createdAt: "2026-08-23T15:00:00.000Z",
            updatedAt: "2026-08-23T16:00:00.000Z",
            hasUnpublishedChanges: false,
            publishedVersionId: "version_8",
            publishedVersion: 8,
            publishedAt: "2026-08-23T16:00:00.000Z",
          });
        }

        throw new Error(`Unexpected RPC procedure: ${path}`);
      }
    );

    const view = renderProbe({ queryClient });

    await act(async () => {
      fireEvent.click(
        await view.findByRole("button", { name: "Start publish" })
      );
    });

    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    expect(requests).toEqual([
      {
        path: "workflow/compareVersion",
        input: {
          workflowId,
          baseVersionId: "version_7",
          draftGraph: expectedSnapshot,
        },
      },
    ]);

    fireEvent.click(view.getByRole("button", { name: "Confirm publish" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toEqual({
      path: "workflow/publish",
      input: {
        workflowId,
        graph: expectedSnapshot,
        expectedPublishedVersionId: "version_7",
      },
    });
    await waitFor(() =>
      expect(queryClient.getQueryState(versionHistoryKey)?.isInvalidated).toBe(
        true
      )
    );
  });

  it("asks the server to compare a first publication with no base version", async () => {
    const requests: Array<{ path: string; input: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = extractRpcProcedurePath(rpcUrl(url));
        const input = await parseRpcRequestInput(init);
        requests.push({ path, input });
        return rpcJsonResponse({
          baseVersion: null,
          proposedVersion: 1,
          baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
          draftGraph: expectedSnapshot,
          hasChanges: true,
          nodeChanges: [{ nodeId: "lifecycle_1", kind: "added", fields: [] }],
          edgeChanges: [],
        });
      }
    );

    const firstState = state();
    firstState.publication = {
      isPublished: false,
      hasUnpublishedChanges: false,
    };
    const view = renderProbe({
      probe: <PublishProbe workflowState={firstState} />,
    });

    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Confirm publish" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests).toEqual([
      {
        path: "workflow/compareVersion",
        input: { workflowId, draftGraph: expectedSnapshot },
      },
      {
        path: "workflow/publish",
        input: {
          workflowId,
          graph: expectedSnapshot,
          expectedPublishedVersionId: null,
        },
      },
    ]);
  });

  it("locks editing through comparison and confirmation, then unlocks on cancellation", async () => {
    const comparison = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url: RequestInfo | URL) => {
        const path = extractRpcProcedurePath(rpcUrl(url));
        if (path === "workflow/compareVersion") {
          return comparison.promise;
        }
        throw new Error(`Unexpected RPC procedure: ${path}`);
      }
    );
    const view = renderProbe();

    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));
    await waitFor(() =>
      expect(
        view.getByRole("status", { name: "editing lock" }).textContent
      ).toBe("true")
    );

    await act(async () => {
      comparison.resolve(
        rpcJsonResponse({
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
        })
      );
    });

    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    expect(view.getByRole("status", { name: "editing lock" }).textContent).toBe(
      "true"
    );

    fireEvent.click(view.getByRole("button", { name: "Cancel review" }));
    await waitFor(() =>
      expect(
        view.getByRole("status", { name: "editing lock" }).textContent
      ).toBe("false")
    );
  });

  it("discards a comparison response after navigating to another workflow", async () => {
    const comparison = deferred<Response>();
    const requests: Array<{ path: string; input: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = extractRpcProcedurePath(rpcUrl(url));
        const input = await parseRpcRequestInput(init);
        requests.push({ path, input });
        if (path === "workflow/compareVersion") {
          return comparison.promise;
        }
        throw new Error(`Unexpected RPC procedure: ${path}`);
      }
    );
    const store = workflowStore();
    const view = renderProbe({
      probe: <NavigationPublishProbe />,
      store,
    });

    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.click(view.getByRole("button", { name: "Open workflow 2" }));
    await act(async () => {
      comparison.resolve(
        rpcJsonResponse({
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
        })
      );
    });

    await waitFor(() => expect(view.getByText("idle")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Confirm publish" }));
    expect(requests).toHaveLength(1);
    expect(store.get(canvasEditingLockedAtom)).toBe(false);
  });
});
