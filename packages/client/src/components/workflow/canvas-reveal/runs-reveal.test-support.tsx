/**
 * The Runs Canvas Reveal harness shared by the Browse and Focus suites. Each
 * suite calls `installRunsRevealRpc` in `beforeEach` after setting a desktop
 * viewport, and `removeRunsRevealRpc` in `afterEach`, because this module is
 * evaluated once per worker and registers no hooks of its own.
 */

import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import { act, fireEvent, render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider as JotaiProvider, useAtomValue } from "jotai";
import { vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { CanvasReveal } from "#src/components/workflow/canvas-reveal/canvas-reveal";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import {
  useClearWorkflowNodeInspection,
  useWorkflowNodeInspection,
} from "#src/components/workflow/use-workflow-node-inspection";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  answerWorkflowRunRpc,
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcJsonResponse,
  rpcUrl,
  type WorkflowRunRpcFixture,
} from "#src/lib/rpc-fetch-test-support";
import {
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
} from "#src/lib/workflow-save-store";
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import type { JsonObject } from "@wfgraph/shared/types/json";

type RawExecution = WorkflowRunRpcFixture["items"][number];

export function execution(
  id: string,
  status: string,
  entityValue: string | null = null
): RawExecution {
  return {
    id,
    workflowId: "wf_1",
    workflowRunId: `run_${id}`,
    status,
    startedAt: "2026-03-01T10:00:00.000Z",
    completedAt: null,
    waitingAt: null,
    cancelledAt: null,
    duration: status === "completed" ? "30000" : null,
    error: null,
    entityValue,
    startEventName: "app/appointment.created",
    runMode: "live",
    startSource: "event",
  };
}

/** One run-log row, as the engine writes one each time a run reaches a node. */
export function log(input: {
  id: string;
  nodeId: string;
  nodeName: string;
  status: string;
  error?: string;
  startedAt?: string;
  input?: JsonObject;
  output?: JsonObject;
}) {
  return {
    id: input.id,
    nodeId: input.nodeId,
    nodeName: input.nodeName,
    nodeType: "action",
    status: input.status,
    startedAt: input.startedAt ?? "2026-03-01T10:00:00.000Z",
    completedAt: null,
    duration: null,
    input: input.input ?? {},
    output: input.output ?? {},
    error: input.error ?? null,
  };
}

/**
 * A pinned graph holding labelled steps, with an optional Group frame that
 * holds the steps named in `members`.
 */
export function labelledGraph(
  steps: Array<{ id: string; label: string }>,
  group?: { id: string; label: string; members: string[] }
): SerializedWorkflowGraph {
  return createSerializedWorkflowGraph({
    nodes: [
      ...(group
        ? [
            {
              id: group.id,
              type: "group",
              position: { x: 0, y: 0 },
              data: { label: group.label, type: "group" as const },
            },
          ]
        : []),
      ...steps.map((step) => ({
        id: step.id,
        type: "action",
        position: { x: 0, y: 0 },
        ...(group?.members.includes(step.id) ? { parentId: group.id } : {}),
        data: {
          label: step.label,
          type: "action" as const,
          config: { actionType: "host/send" },
        },
      })),
    ],
    edges: [],
  });
}

/**
 * Stand-ins for the run canvas: a React Flow node element for each node of the
 * pinned graph, and the empty pane. A node click runs the canvas's own node
 * inspection and a pane click its own clear, as the canvas handlers do.
 */
function CanvasStubs() {
  const nodes = useAtomValue(executionOverlayGraphAtom)?.nodes ?? [];
  const inspectNode = useWorkflowNodeInspection();
  const clearInspection = useClearWorkflowNodeInspection();
  return (
    <>
      <button
        aria-label="Canvas pane"
        onClick={clearInspection}
        type="button"
      />
      {nodes.map((node) => (
        <button
          aria-label={`Canvas ${node.data.label}`}
          className="react-flow__node"
          data-id={node.id}
          key={node.id}
          onClick={() => inspectNode(node.id)}
          type="button"
        />
      ))}
    </>
  );
}

/** A pinned graph holding one step, so each run projects a graph of its own. */
export function pinnedGraph(nodeId: string): SerializedWorkflowGraph {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: nodeId,
        type: "action",
        position: { x: 0, y: 0 },
        data: { label: nodeId, type: "action", config: {} },
      },
    ],
    edges: [],
  });
}

export const served: WorkflowRunRpcFixture = {
  items: [],
  supersededCount: 0,
  graphs: {},
  logsSummaryExtras: {},
  logsByExecutionId: {},
  waitsByExecutionId: {},
};

/**
 * `calls` is each RPC request the stub received, by procedure path.
 * `override` answers one request in place of the served fixture, such as a
 * held or failed response; returning undefined leaves it to the fixture.
 */
export const runsRpc: {
  calls: Array<{ path: string; input: JsonObject }>;
  override:
    | ((path: string, input: JsonObject) => Promise<Response> | undefined)
    | undefined;
} = { calls: [], override: undefined };

export function callCount(path: string): number {
  return runsRpc.calls.filter((call) => call.path === path).length;
}

/** Reset the fixture, grant every operation, and stub `fetch` with it. */
export function installRunsRevealRpc() {
  installAuthorizationGrantsForTests(WfGraphOperationIds);
  served.items = [];
  served.supersededCount = 0;
  served.refusedStarts = [];
  served.cancelNotDelivered = [];
  served.graphs = {};
  served.logsSummaryExtras = {};
  served.logsByExecutionId = {};
  served.waitsByExecutionId = {};
  served.exitByExecutionId = {};
  runsRpc.calls = [];
  runsRpc.override = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = extractRpcProcedurePath(rpcUrl(input));
      const requestInput = await parseRpcRequestInput(init);
      runsRpc.calls.push({ path, input: requestInput });
      return (
        runsRpc.override?.(path, requestInput) ??
        answerWorkflowRunRpc(served, path, requestInput)
      );
    })
  );
}

export function removeRunsRevealRpc() {
  vi.unstubAllGlobals();
  resetAuthorizationGrantsForTests();
}

/** Press Escape where the Reveal keyboard handler listens. */
function escape() {
  fireEvent.keyDown(document.body, { key: "Escape" });
}

export async function renderRunsReveal(search: WorkflowRouteSearch) {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, { nodes: [], edges: [] });
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(currentWorkflowNameAtom, "Appointment reminders");

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (input: WorkflowRouteSearch & SearchSchemaInput) =>
      authorizedWorkflowSearch(input, {
        canOpenRuns: true,
        canOpenComparison: true,
      }),
    component: () => (
      <div className="relative" data-testid="canvas-area">
        <div data-testid="workflow-canvas">
          <CanvasStubs />
        </div>
        <ExecutionOverlaySync />
        <WorkspaceRouteSync />
        <CanvasReveal />
      </div>
    ),
  });
  const query = new URLSearchParams(
    Object.entries(search).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  ).toString();
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [`/workflows/wf_1${query ? `?${query}` : ""}`],
    }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const view = render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ExtensionCatalogProvider value={emptyExtensionCatalog}>
          <IntegrationUiProvider value={{}}>
            <ReactFlowProvider>
              <OverlayProvider>
                <RouterProvider router={router} />
              </OverlayProvider>
            </ReactFlowProvider>
          </IntegrationUiProvider>
        </ExtensionCatalogProvider>
      </QueryClientProvider>
    </JotaiProvider>
  );
  await view.findByTestId("canvas-area");

  const aside = () =>
    view.container.querySelector<HTMLElement>('[data-slot="canvas-reveal"]');
  const title = () =>
    aside()?.querySelector("header h2")?.textContent ?? undefined;
  const path = () =>
    aside()?.querySelector('[data-slot="reveal-path"]')?.textContent;
  const rows = () => view.queryAllByTestId("workflow-run-summary-row");
  const show = async (next: WorkflowRouteSearch) => {
    await act(async () => {
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_1" },
        search: next,
      });
    });
  };
  const back = () =>
    fireEvent.click(view.getByRole("button", { name: "Back" }));
  const evidence = () => view.getByTestId("run-node-evidence");
  const canvasNode = async (label: string) =>
    view.findByRole("button", { name: `Canvas ${label}` });
  const clickPane = () =>
    fireEvent.click(view.getByRole("button", { name: "Canvas pane" }));
  const overviewScroller = () =>
    aside()?.querySelector<HTMLElement>(".overflow-y-auto") ?? null;
  const listScroller = () =>
    aside()?.querySelector<HTMLElement>('[data-slot="runs-list-scroller"]') ??
    null;
  return {
    view,
    store,
    router,
    queryClient,
    aside,
    title,
    path,
    rows,
    show,
    back,
    escape,
    evidence,
    canvasNode,
    clickPane,
    overviewScroller,
    listScroller,
  };
}

/** Let every pending after-paint timer run. */
export async function afterPaint() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** Answer the run's audit events with `events` instead of an empty list. */
export function serveEvents(events: JsonObject[]) {
  runsRpc.override = (path) =>
    path === "workflow/getExecutionEvents"
      ? Promise.resolve(rpcJsonResponse({ events }))
      : undefined;
}

export function waitingRun(id: string, token: string) {
  return [
    {
      id: `wait_${id}`,
      nodeId: "w",
      nodeName: `Wait in ${id}`,
      resumeToken: token,
      subscribedEvents: [],
      waitUntil: null,
    },
  ];
}

/** The options of the first observer reading the query under `queryKey`. */
export function observerOptions(queryClient: QueryClient, queryKey: QueryKey) {
  const [query] = queryClient.getQueryCache().findAll({ queryKey });
  const [observer] = query?.observers ?? [];
  if (!observer) {
    throw new Error("no observer reads this query");
  }
  return observer.options;
}
