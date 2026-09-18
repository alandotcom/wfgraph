import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type RouterHistory,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import {
  ReactFlowProvider,
  useReactFlow,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import type {
  SerializedWorkflowGraph,
  WorkflowNode as PersistedWorkflowNode,
} from "@wfgraph/shared/graph/types";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { CanvasReveal } from "#src/components/workflow/canvas-reveal/canvas-reveal";
import { changesMobileSheet } from "#src/components/workflow/canvas-reveal/changes-summary";
import {
  MobileReveal,
  MobileRevealCovered,
} from "#src/components/workflow/canvas-reveal/mobile-reveal";
import {
  execution,
  installRunsRevealRpc,
  log,
  removeRunsRevealRpc,
  runsRpc,
  served,
} from "#src/components/workflow/canvas-reveal/runs-reveal.test-support";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import { RunStatusProjection } from "#src/components/workflow/run-status-projection";
import { WorkflowCanvas } from "#src/components/workflow/workflow-canvas";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import { useWorkflowWorkspaceNavigation } from "#src/hooks/use-workflow-workspace-navigation";
import { rpcJsonResponse } from "#src/lib/rpc-fetch-test-support";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  beginWorkflowComparisonRequestAtom,
  installWorkflowComparisonAtom,
  settleWorkflowComparisonRequestAtom,
} from "#src/lib/workflow-comparison-store";
import { historyAtom } from "#src/lib/workflow-graph-cells";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import { toEditorEdge, toEditorNode } from "#src/lib/workflow-graph-types";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  hasUnsavedChangesAtom,
} from "#src/lib/workflow-save-store";
import {
  activeMobileSheetsAtom,
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  activeWorkspaceCamerasAtom,
  openMobileSelectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import { setViewportWidth } from "#src/lib/viewport-test-support";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [],
  actions: [
    {
      id: "mail/send",
      label: "Send email",
      description: "Send one email",
      category: "Mail",
      configFields: [{ key: "subject", label: "Subject", type: "text" }],
      outputFields: [],
    },
  ],
};

function step(
  id: string,
  label: string,
  subject: string,
  parentId?: string
): PersistedWorkflowNode {
  return omitUndefined({
    id,
    parentId,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label,
      type: "action",
      config: { actionType: "mail/send", subject },
    },
  });
}

function outreach(label = "Initial outreach"): PersistedWorkflowNode {
  return {
    id: "outreach",
    type: "group",
    position: { x: 0, y: 200 },
    width: 400,
    height: 112,
    data: { label, type: "group", config: { direction: "horizontal" } },
  };
}

/**
 * Qualification, then the left-to-right Group "Initial outreach" holding
 * "Send welcome back" and "Send case study", then "Route outcome".
 */
function workflowNodes(
  options: { caseStudySubject?: string; groupLabel?: string } = {}
): PersistedWorkflowNode[] {
  return [
    step("qualify", "Qualification", "Qualify"),
    outreach(options.groupLabel),
    step("welcome", "Send welcome back", "Welcome", "outreach"),
    step(
      "case_study",
      "Send case study",
      options.caseStudySubject ?? "Case study",
      "outreach"
    ),
    step("route", "Route outcome", "Route"),
  ];
}

const WORKFLOW_EDGES = [
  { id: "qualify-welcome", source: "qualify", target: "welcome" },
  { id: "welcome-case", source: "welcome", target: "case_study" },
  { id: "case-route", source: "case_study", target: "route" },
];

function graphOf(
  nodes: readonly PersistedWorkflowNode[]
): SerializedWorkflowGraph {
  return createSerializedWorkflowGraph({ nodes, edges: WORKFLOW_EDGES });
}

const DRAFT_NODES = workflowNodes({ caseStudySubject: "Case study, updated" });
const DRAFT = graphOf(DRAFT_NODES);

/** The workspace switcher's three controls, as the toolbar offers them. */
function WorkspaceSwitcher() {
  const workspace = useWorkflowWorkspaceNavigation();
  return (
    <>
      <button onClick={workspace.showDraft} type="button">
        Show Draft
      </button>
      <button onClick={workspace.showRuns} type="button">
        Show Runs
      </button>
      <button onClick={workspace.showChanges} type="button">
        Show Changes
      </button>
    </>
  );
}

/** Hands the test the canvas's React Flow instance, which moves the camera. */
function FlowHandle({
  onInstance,
}: {
  onInstance: (instance: ReactFlowInstance) => void;
}) {
  onInstance(useReactFlow());
  return null;
}

/** The rendered phone editor and the reads and gestures a case drives it with. */
type PhoneEditor = {
  view: ReturnType<typeof render>;
  store: ReturnType<typeof createStore>;
  router: { history: RouterHistory };
  search: () => unknown;
  canvasNode: (id: string) => HTMLElement | null;
  tapNode: (id: string) => Promise<void>;
  handleSides: (id: string) => (string | undefined)[];
  sheet: () => HTMLElement | null;
  inSheet: () => ReturnType<typeof within>;
  title: () => string | null | undefined;
  status: () => string | null | undefined;
  press: (name: string | RegExp) => void;
  levels: () => string[];
  openSheet: () => Promise<void>;
  moveCamera: (viewport: Viewport) => Promise<void>;
  expectCamera: (viewport: Viewport) => void;
  scope: () => ReturnType<typeof activeWorkspaceAddressAtom.read>["scope"];
  leaveGroup: () => Promise<void>;
};

/**
 * The editor below `md` with the real canvas, over a Draft of `DRAFT`, the run
 * fixture `served` and, when given, `comparison` installed for "version_3".
 */
async function renderPhoneEditor(input: {
  search: string;
  comparison?: WorkflowComparisonPayload | undefined;
}): Promise<PhoneEditor> {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, {
    nodes: DRAFT_NODES.map((node) => toEditorNode(node)),
    edges: WORKFLOW_EDGES.map((edge) => toEditorEdge(edge)),
  });
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(currentWorkflowNameAtom, "Patient reactivation");
  const { comparison } = input;
  if (comparison) {
    const epoch = store.set(beginWorkflowComparisonRequestAtom, "wf_1");
    store.set(installWorkflowComparisonAtom, {
      workflowId: "wf_1",
      epoch,
      payload: comparison,
    });
    store.set(settleWorkflowComparisonRequestAtom, {
      workflowId: "wf_1",
      epoch,
    });
    runsRpc.override = (path) =>
      path === "workflow/compareVersion"
        ? Promise.resolve(rpcJsonResponse(comparison))
        : undefined;
  }

  const flow: { instance: ReactFlowInstance | null } = { instance: null };
  const keepFlow = (instance: ReactFlowInstance) => {
    flow.instance = instance;
  };
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: WorkflowRouteSearch & SearchSchemaInput) =>
      authorizedWorkflowSearch(search, {
        canOpenRuns: true,
        canOpenComparison: true,
      }),
    component: () => (
      <>
        <FlowHandle onInstance={keepFlow} />
        <WorkspaceSwitcher />
        <div className="relative" data-testid="canvas-area">
          <WorkspaceRouteSync />
          <ExecutionOverlaySync />
          <RunStatusProjection />
          <MobileRevealCovered>
            <WorkflowCanvas canEdit />
          </MobileRevealCovered>
          <CanvasReveal />
          <MobileReveal />
        </div>
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [`/workflows/wf_1${input.search}`],
    }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(["integration", "getAll"] as never, [] as never);

  const view = render(
    <ExtensionCatalogProvider value={catalog}>
      <IntegrationUiProvider value={{}}>
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={store}>
            <ReactFlowProvider>
              <OverlayProvider>
                <RouterProvider router={router} />
              </OverlayProvider>
            </ReactFlowProvider>
          </JotaiProvider>
        </QueryClientProvider>
      </IntegrationUiProvider>
    </ExtensionCatalogProvider>
  );
  await view.findByTestId("canvas-area");

  const search = () => router.state.location.search;
  const canvasNode = (id: string) =>
    view.container.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${CSS.escape(id)}"]`
    );
  const tapNode = async (id: string) => {
    const element = await waitFor(() => {
      const found = canvasNode(id);
      if (!found) {
        throw new Error(`node ${id} is not on the canvas`);
      }
      return found;
    });
    await act(async () => {
      fireEvent.click(element);
    });
  };
  const handleSides = (id: string) =>
    [
      ...(canvasNode(id)?.querySelectorAll<HTMLElement>(
        ".react-flow__handle"
      ) ?? []),
    ].map((handle) => handle.dataset.handlepos);
  const sheet = () =>
    view.container.querySelector<HTMLElement>('[data-slot="mobile-reveal"]');
  const inSheet = () => {
    const element = sheet();
    if (!element) {
      throw new Error("no mobile sheet is on screen");
    }
    return within(element);
  };
  const title = () =>
    sheet()?.querySelector('[data-slot="reveal-title"]')?.textContent;
  const status = () =>
    sheet()?.querySelector('[data-slot="reveal-title"]')?.nextElementSibling
      ?.textContent;
  const press = (name: string | RegExp) =>
    fireEvent.click(inSheet().getByRole("button", { name }));
  const levels = () =>
    store
      .get(activeMobileSheetsAtom)
      .map((item) => `${item.level}:${item.inspected?.id ?? "address"}`);
  const openSheet = async () => {
    await act(async () => {
      store.set(openMobileSelectionAtom, store.get(activeWorkspaceAddressAtom));
    });
  };
  /**
   * Pan and zoom the canvas, as a person's gesture does, once the canvas's own
   * camera placement and any sheet's placement animation have ended, and wait
   * for the address to record the camera the movement ended at.
   */
  const moveCamera = async (viewport: Viewport) => {
    let previous = "";
    await waitFor(
      () => {
        const shown = JSON.stringify(flow.instance?.getViewport());
        const settled = shown === previous;
        previous = shown;
        expect(settled).toBe(true);
      },
      { interval: 100 }
    );
    await act(async () => {
      await flow.instance?.setViewport(viewport, { duration: 0 });
    });
    await waitFor(() =>
      expect(store.get(activeWorkspaceCamerasAtom).mobile?.zoom).toBe(
        viewport.zoom
      )
    );
  };
  /** Whether the canvas shows `viewport`, to within rounding. */
  const expectCamera = (viewport: Viewport) => {
    const shown = flow.instance?.getViewport();
    expect(shown?.x).toBeCloseTo(viewport.x);
    expect(shown?.y).toBeCloseTo(viewport.y);
    expect(shown?.zoom).toBeCloseTo(viewport.zoom);
  };
  const scope = () => store.get(activeWorkspaceAddressAtom).scope;
  /** Press the focused Group canvas's **Workflow** button. */
  const leaveGroup = async () => {
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Workflow" }));
    });
  };
  return {
    view,
    store,
    router,
    search,
    canvasNode,
    tapNode,
    handleSides,
    sheet,
    inSheet,
    title,
    status,
    press,
    levels,
    openSheet,
    moveCamera,
    expectCamera,
    scope,
    leaveGroup,
  };
}

/** What stays true of the stored draft through every Runs and Changes step. */
function expectDraftUntouched(store: ReturnType<typeof createStore>) {
  const positions = (nodes: readonly { id: string; position: unknown }[]) =>
    new Map(nodes.map((node) => [node.id, node.position]));
  expect(positions(store.get(nodesAtom))).toEqual(positions(DRAFT_NODES));
  expect(store.get(historyAtom)).toEqual([]);
  expect(store.get(hasUnsavedChangesAtom)).toBe(false);
}

/** No control a phone shows in Runs or Changes edits the graph's shape. */
function expectNoTopologyAuthoring(editor: {
  view: ReturnType<typeof render>;
  canvasNode: (id: string) => HTMLElement | null;
}) {
  const topology =
    /^(Delete|Duplicate|Group steps|Ungroup|Add step|Tidy layout|Reflow nodes|Reset comparison layout)/;
  expect(editor.view.queryAllByRole("button", { name: topology })).toEqual([]);
  for (const node of editor.view.container.querySelectorAll<HTMLElement>(
    ".react-flow__node"
  )) {
    expect(node.classList.contains("draggable")).toBe(false);
  }
  for (const handle of editor.view.container.querySelectorAll<HTMLElement>(
    ".react-flow__handle"
  )) {
    expect(handle.classList.contains("connectable")).toBe(false);
  }
}

beforeEach(() => {
  setViewportWidth(390);
  installRunsRevealRpc();
  served.graphs = {
    ver_exec_f: graphOf(workflowNodes()),
    ver_exec_w: graphOf(workflowNodes()),
  };
});

afterEach(() => {
  setViewportWidth(1440);
  removeRunsRevealRpc();
});

describe("mobile Runs Group drill-in", () => {
  it("goes from a failed run's Group summary into the focused Group and a member's evidence, and Back restores each level", async () => {
    served.items = [execution("exec_f", "failed")];
    served.logsByExecutionId = {
      exec_f: [
        log({
          id: "log_qualify",
          nodeId: "qualify",
          nodeName: "Qualification",
          status: "success",
        }),
        log({
          id: "log_welcome",
          nodeId: "welcome",
          nodeName: "Send welcome back",
          status: "success",
          startedAt: "2026-03-01T10:00:01.000Z",
        }),
        log({
          id: "log_case",
          nodeId: "case_study",
          nodeName: "Send case study",
          status: "error",
          error: "SMTP refused the message",
          startedAt: "2026-03-01T10:00:02.000Z",
        }),
      ],
    };
    const editor = await renderPhoneEditor({
      search: "?view=runs&executionId=exec_f",
    });
    const { view, store, search, inSheet, title, status, press, levels } =
      editor;
    await editor.openSheet();
    await waitFor(() => expect(title()).toBe("Run #1"));

    // Workflow: the Group card opens its run summary with member statuses.
    await editor.tapNode("outreach");
    const summary = await view.findByTestId("runs-group-summary");
    expect(title()).toBe("Initial outreach");
    expect(status()).toBe("Failed");
    expect(editor.sheet()?.dataset.level).toBe("summary");
    expect(
      within(summary)
        .getAllByRole("button", { name: /, / })
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual(["Send welcome back, Success", "Send case study, Error"]);
    expectNoTopologyAuthoring(editor);

    // Group summary: a member enters the Group and shows its evidence.
    press("Send case study, Error");
    await waitFor(() =>
      expect(search()).toEqual({
        view: "runs",
        executionId: "exec_f",
        group: "outreach",
      })
    );
    await waitFor(() =>
      expect(editor.sheet()?.dataset.level).toBe("inspector")
    );
    expect(levels()).toEqual(["summary:address", "inspector:case_study"]);
    expect(title()).toBe("Send case study");
    expect(
      inSheet().getAllByText("SMTP refused the message").length
    ).toBeGreaterThan(0);
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["case_study"]);

    // The focused Group draws top to bottom beneath the sheets.
    press("Back to Run #1");
    await waitFor(() => expect(editor.sheet()?.dataset.level).toBe("summary"));
    await waitFor(() =>
      expect(editor.handleSides("welcome")).toEqual(["top", "bottom"])
    );
    expectNoTopologyAuthoring(editor);

    // Back on the run's sheet inside the Group leaves the Group's canvas
    // showing, and Workflow returns to the overview's Group run summary.
    press("Back to Initial outreach");
    await waitFor(() => expect(editor.sheet()).toBeNull());
    expect(editor.scope()).toEqual({ kind: "group", groupId: "outreach" });
    expect(search()).toEqual({
      view: "runs",
      executionId: "exec_f",
      group: "outreach",
    });
    await editor.leaveGroup();
    await waitFor(() => expect(editor.scope()).toEqual({ kind: "overview" }));
    await waitFor(() => expect(title()).toBe("Initial outreach"));
    expect(search()).toEqual({ view: "runs", executionId: "exec_f" });
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["outreach"]);

    // Enter group carries the run's sheet into the Group.
    press(/Enter group/);
    await waitFor(() =>
      expect(editor.scope()).toEqual({ kind: "group", groupId: "outreach" })
    );
    await waitFor(() => expect(title()).toBe("Run #1"));
    expect(
      inSheet().getByRole("button", { name: "Back to Initial outreach" })
    ).toBeTruthy();
    expectDraftUntouched(store);
  });

  it("moves between the overview and the Group with browser Back and Forward after Back on the run's sheet inside the Group", async () => {
    served.items = [execution("exec_f", "failed")];
    served.logsByExecutionId = {
      exec_f: [
        log({
          id: "log_case",
          nodeId: "case_study",
          nodeName: "Send case study",
          status: "error",
          error: "SMTP refused the message",
        }),
      ],
    };
    const editor = await renderPhoneEditor({
      search: "?view=runs&executionId=exec_f",
    });
    const { view, search, title, press } = editor;
    await editor.openSheet();
    await waitFor(() => expect(title()).toBe("Run #1"));
    await editor.tapNode("outreach");
    await view.findByTestId("runs-group-summary");
    press(/Enter group/);
    await waitFor(() =>
      expect(editor.scope()).toEqual({ kind: "group", groupId: "outreach" })
    );
    await waitFor(() => expect(title()).toBe("Run #1"));

    press("Back to Initial outreach");
    await waitFor(() => expect(editor.sheet()).toBeNull());

    await act(async () => {
      editor.router.history.back();
    });
    await waitFor(() =>
      expect(search()).toEqual({ view: "runs", executionId: "exec_f" })
    );
    expect(editor.scope()).toEqual({ kind: "overview" });
    await waitFor(() => expect(title()).toBe("Initial outreach"));

    await act(async () => {
      editor.router.history.forward();
    });
    await waitFor(() =>
      expect(search()).toEqual({
        view: "runs",
        executionId: "exec_f",
        group: "outreach",
      })
    );
    expect(editor.scope()).toEqual({ kind: "group", groupId: "outreach" });
    await waitFor(() =>
      expect(editor.handleSides("welcome")).toEqual(["top", "bottom"])
    );
    // Forward carries the run's sheet into the Group, as Enter group does.
    await waitFor(() => expect(title()).toBe("Run #1"));
    expect(editor.levels()).toEqual(["summary:address"]);
    expectDraftUntouched(editor.store);
  });

  it("enters the Group first when a waiting member's journey entry is chosen on the overview", async () => {
    served.items = [execution("exec_w", "waiting")];
    served.logsByExecutionId = {
      exec_w: [
        log({
          id: "log_qualify",
          nodeId: "qualify",
          nodeName: "Qualification",
          status: "success",
        }),
        log({
          id: "log_welcome",
          nodeId: "welcome",
          nodeName: "Send welcome back",
          status: "running",
          startedAt: "2026-03-01T10:00:01.000Z",
        }),
      ],
    };
    served.waitsByExecutionId = {
      exec_w: [
        {
          id: "wait_welcome",
          nodeId: "welcome",
          nodeName: "Send welcome back",
          resumeToken: "tok_w",
          subscribedEvents: [],
          waitUntil: null,
        },
      ],
    };
    const editor = await renderPhoneEditor({
      search: "?view=runs&executionId=exec_w",
    });
    const { view, search, title, status, press, levels } = editor;
    await editor.openSheet();
    await waitFor(() => expect(title()).toBe("Run #1"));

    await editor.tapNode("outreach");
    await view.findByTestId("runs-group-summary");
    expect(status()).toBe("Waiting");
    press("Back to Run #1");
    await waitFor(() => expect(title()).toBe("Run #1"));

    // The journey entry names a step the overview hides inside the Group.
    press("Send welcome back, Running");
    await waitFor(() =>
      expect(search()).toEqual({
        view: "runs",
        executionId: "exec_w",
        group: "outreach",
      })
    );
    await waitFor(() =>
      expect(editor.sheet()?.dataset.level).toBe("inspector")
    );
    expect(levels()).toEqual(["summary:address", "inspector:welcome"]);
    expect(title()).toBe("Send welcome back");
    expect(editor.canvasNode("welcome")).not.toBeNull();
  });
});

/** Case study's subject changed inside the Group, and Route outcome's outside. */
function childModification(): WorkflowComparisonPayload {
  return {
    baseVersion: {
      id: "version_3",
      version: 3,
      publishedAt: "2026-09-01T00:00:00.000Z",
      isCurrent: true,
    },
    proposedVersion: 4,
    baseGraph: graphOf(
      workflowNodes().map((node) =>
        node.id === "route"
          ? step("route", "Route outcome", "Route before")
          : node
      )
    ),
    draftGraph: DRAFT,
    hasChanges: true,
    nodeChanges: [
      {
        nodeId: "route",
        kind: "modified",
        fields: [
          {
            path: ["data", "config", "subject"],
            kind: "modified",
            before: "Route before",
            after: "Route",
          },
        ],
      },
      {
        nodeId: "case_study",
        kind: "modified",
        fields: [
          {
            path: ["data", "config", "subject"],
            kind: "modified",
            before: "Case study",
            after: "Case study, updated",
          },
        ],
      },
    ],
    edgeChanges: [],
  };
}

describe("mobile Changes Group drill-in", () => {
  it("opens the first changed member from a Group card's changed count, and Previous and Next cross the Group boundary", async () => {
    const editor = await renderPhoneEditor({
      search: "?view=changes&compare=version_3",
      comparison: childModification(),
    });
    const { store, search, inSheet, title, press } = editor;
    const sheets = () =>
      store.get(activeMobileSheetsAtom).map(changesMobileSheet);

    // The Group card's changed count opens the member's field differences.
    const changed = await waitFor(() => {
      const button = editor.view.container.querySelector<HTMLElement>(
        '[data-slot="group-changed-steps"]'
      );
      if (!button) {
        throw new Error("the Group card shows no changed count");
      }
      return button;
    });
    expect(changed.textContent).toBe("1 changed");
    await act(async () => {
      fireEvent.click(changed);
    });
    await waitFor(() =>
      expect(search()).toEqual({
        view: "changes",
        compare: "version_3",
        group: "outreach",
      })
    );
    await waitFor(() => expect(title()).toBe("Send case study"));
    expect(sheets()).toEqual(["summary", "change"]);
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["case_study"]);
    expect(
      within(inSheet().getByRole("list", { name: "Settings of this step" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual([expect.stringContaining("Case study, updated")]);
    await waitFor(() =>
      expect(editor.handleSides("welcome")).toEqual(["top", "bottom"])
    );
    expectNoTopologyAuthoring(editor);

    // Previous leaves the Group for the change drawn on the overview, and Next
    // enters the Group again, each in the same sheet.
    press("Previous change");
    await waitFor(() => expect(editor.scope()).toEqual({ kind: "overview" }));
    await waitFor(() => expect(title()).toBe("Route outcome"));
    expect(sheets()).toEqual(["summary", "change"]);
    press("Next change");
    await waitFor(() =>
      expect(editor.scope()).toEqual({ kind: "group", groupId: "outreach" })
    );
    await waitFor(() => expect(title()).toBe("Send case study"));
    expect(sheets()).toEqual(["summary", "change"]);

    // The comparison summary inside the Group leads back to the Group canvas.
    press("Back to Summary");
    expect(sheets()).toEqual(["summary"]);
    press("Back to Initial outreach");
    expect(editor.sheet()).toBeNull();
    expect(editor.scope()).toEqual({ kind: "group", groupId: "outreach" });
    expectDraftUntouched(store);
  });

  it("shows an organization-only Group's summary from its card, and a membership-only member inside the Group", async () => {
    const comparison: WorkflowComparisonPayload = {
      baseVersion: {
        id: "version_3",
        version: 3,
        publishedAt: "2026-09-01T00:00:00.000Z",
        isCurrent: true,
      },
      proposedVersion: 4,
      baseGraph: graphOf(
        workflowNodes({
          groupLabel: "Reminders",
          caseStudySubject: "Case study, updated",
        }).map((node) =>
          node.id === "welcome"
            ? step("welcome", "Send welcome back", "Welcome")
            : node
        )
      ),
      draftGraph: DRAFT,
      hasChanges: true,
      nodeChanges: [
        {
          nodeId: "outreach",
          kind: "modified",
          fields: [
            {
              path: ["data", "label"],
              kind: "modified",
              before: "Reminders",
              after: "Initial outreach",
            },
          ],
        },
        {
          nodeId: "welcome",
          kind: "modified",
          fields: [{ path: ["parentId"], kind: "added", after: "outreach" }],
        },
      ],
      edgeChanges: [],
    };
    const editor = await renderPhoneEditor({
      search: "?view=changes&compare=version_3",
      comparison,
    });
    const { store, search, inSheet, title, press } = editor;
    const sheets = () =>
      store.get(activeMobileSheetsAtom).map(changesMobileSheet);

    // The Group card opens the Group's organization summary.
    await editor.tapNode("outreach");
    await waitFor(() => expect(title()).toBe("Initial outreach"));
    expect(sheets()).toEqual(["summary", "change"]);
    expect(inSheet().getByText(/execution behavior is unchanged/)).toBeTruthy();
    const members = inSheet()
      .getByRole("heading", { name: "Changed steps in this Group" })
      .closest("section") as HTMLElement;
    expectNoTopologyAuthoring(editor);

    // A membership-only member shows inside the Group.
    fireEvent.click(
      within(members).getByRole("button", {
        name: "Send welcome back Group membership",
      })
    );
    await waitFor(() => expect(search()).toMatchObject({ group: "outreach" }));
    await waitFor(() => expect(title()).toBe("Send welcome back"));
    expect(
      inSheet().getByRole("list", { name: "Group membership of this step" })
    ).toBeTruthy();

    // Back inside the Group removes the member's sheet, and Workflow returns to
    // the overview's organization summary, which enters the Group.
    press("Back to Summary");
    await waitFor(() => expect(sheets()).toEqual(["summary"]));
    expect(editor.scope()).toEqual({ kind: "group", groupId: "outreach" });
    await editor.leaveGroup();
    await waitFor(() => expect(editor.scope()).toEqual({ kind: "overview" }));
    await waitFor(() => expect(title()).toBe("Initial outreach"));
    expect(sheets()).toEqual(["summary", "change"]);
    press(/Enter group/);
    await waitFor(() =>
      expect(editor.scope()).toEqual({ kind: "group", groupId: "outreach" })
    );
    await waitFor(() =>
      expect(editor.handleSides("case_study")).toEqual(["top", "bottom"])
    );
    await waitFor(() => expect(sheets()).toEqual(["summary"]));
    expect(title()).toBe("Version 3 → proposed version 4");
    expect(
      inSheet().getByRole("button", { name: "Back to Initial outreach" })
    ).toBeTruthy();
    expectDraftUntouched(store);
  });
});

describe("mobile workspace switching inside Groups", () => {
  it("restores each workspace's Group scope, sheet depth, selection and camera", async () => {
    served.items = [execution("exec_f", "failed")];
    served.logsByExecutionId = {
      exec_f: [
        log({
          id: "log_case",
          nodeId: "case_study",
          nodeName: "Send case study",
          status: "error",
          error: "SMTP refused the message",
        }),
      ],
    };
    const editor = await renderPhoneEditor({
      search: "?view=changes",
      comparison: childModification(),
    });
    const { view, store, search, title, press, levels } = editor;
    const selected = () => store.get(activeSelectionAtom).nodeIds;
    const switchTo = async (name: string) => {
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name }));
      });
    };

    // Changes: the member's field differences inside the Group.
    await editor.openSheet();
    await waitFor(() => expect(title()).toBe("Version 3 → proposed version 4"));
    const changed = await waitFor(() => {
      const button = view.container.querySelector<HTMLElement>(
        '[data-slot="group-changed-steps"]'
      );
      if (!button) {
        throw new Error("the Group card shows no changed count");
      }
      return button;
    });
    await act(async () => {
      fireEvent.click(changed);
    });
    await waitFor(() => expect(title()).toBe("Send case study"));
    const changesCamera = { x: 30, y: -300, zoom: 0.8 };
    await editor.moveCamera(changesCamera);

    // Draft: a member's inspector inside the Group.
    await switchTo("Show Draft");
    await waitFor(() => expect(search()).toEqual({}));
    await editor.tapNode("outreach");
    press(/Enter group/);
    await waitFor(() => expect(search()).toEqual({ group: "outreach" }));
    await editor.tapNode("case_study");
    press("Open editor");
    await waitFor(() =>
      expect(editor.sheet()?.dataset.level).toBe("inspector")
    );
    const draftCamera = { x: 10, y: -100, zoom: 1.2 };
    await editor.moveCamera(draftCamera);

    // Runs: the newest run's member evidence inside the Group.
    await switchTo("Show Runs");
    await waitFor(() => expect(title()).toBe("Run #1"));
    await editor.tapNode("outreach");
    await view.findByTestId("runs-group-summary");
    press("Send case study, Error");
    await waitFor(() =>
      expect(editor.sheet()?.dataset.level).toBe("inspector")
    );
    const runsCamera = { x: 50, y: -500, zoom: 0.6 };
    await editor.moveCamera(runsCamera);

    await switchTo("Show Changes");
    await waitFor(() =>
      expect(search()).toEqual({
        view: "changes",
        compare: "version_3",
        group: "outreach",
      })
    );
    await waitFor(() => expect(title()).toBe("Send case study"));
    expect(store.get(activeMobileSheetsAtom).map(changesMobileSheet)).toEqual([
      "summary",
      "change",
    ]);
    expect(selected()).toEqual(["case_study"]);
    editor.expectCamera(changesCamera);

    await switchTo("Show Draft");
    await waitFor(() => expect(search()).toEqual({ group: "outreach" }));
    await waitFor(() =>
      expect(editor.sheet()?.dataset.level).toBe("inspector")
    );
    expect(levels()).toEqual(["summary:case_study", "inspector:case_study"]);
    expect(selected()).toEqual(["case_study"]);
    editor.expectCamera(draftCamera);

    await switchTo("Show Runs");
    await waitFor(() =>
      expect(search()).toEqual({
        view: "runs",
        executionId: "exec_f",
        group: "outreach",
      })
    );
    await waitFor(() => expect(title()).toBe("Send case study"));
    expect(levels()).toEqual(["summary:address", "inspector:case_study"]);
    expect(selected()).toEqual(["case_study"]);
    editor.expectCamera(runsCamera);
    expectDraftUntouched(store);
  });
});
