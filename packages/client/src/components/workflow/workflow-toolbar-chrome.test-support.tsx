import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  ToolbarActions,
  ToolbarPublishControls,
  CommandPaletteTrigger,
} from "#src/components/workflow/workflow-toolbar-chrome";
import type {
  WorkflowToolbarActions,
  WorkflowToolbarState,
} from "#src/components/workflow/workflow-toolbar-handlers";
import {
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
} from "#src/lib/workflow-graph-store";
import {
  isGeneratingAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import {
  currentWorkflowIdAtom,
  isWorkflowOwnerAtom,
} from "#src/lib/workflow-save-store";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { toEditorNode } from "#src/lib/workflow-graph-types";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const emptyCatalog: ExtensionCatalog = {
  events: [],
  actions: [],
  integrations: [],
};

// One real lifecycle node, so the "at least one real step" arm of
// `publishDisabled` is already satisfied and the overlay is the only thing
// left that can gate the button.
export const REAL_NODES = toWorkflowGraphData(
  createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle_1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { label: "Lifecycle", type: "lifecycle" },
      },
    ],
    edges: [],
  })
).nodes.map(toEditorNode);

/**
 * Two real steps, which is the fewest "Tidy layout" will act on. The single
 * lifecycle node above leaves it disabled for want of anything to arrange, and
 * a case about the run lock has to fail for the run lock.
 */
export const MANY_REAL_NODES = toWorkflowGraphData(
  createSerializedWorkflowGraph({
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
        position: { x: 0, y: 200 },
        data: { label: "Step", type: "action" },
      },
    ],
    edges: [],
  })
).nodes.map(toEditorNode);

function baseState(): WorkflowToolbarState {
  return {
    nodes: REAL_NODES,
    edges: [],
    isExecuting: false,
    setIsExecuting: vi.fn(),
    isGenerating: false,
    clearWorkflow: vi.fn(),
    updateNodeData: vi.fn(),
    currentWorkflowId: "workflow_1",
    workflowName: "Workflow",
    workflowMode: "live",
    setCurrentWorkflowMode: vi.fn(),
    isOwner: true,
    isSaving: false,
    hasUnsavedChanges: false,
    undo: vi.fn(),
    redo: vi.fn(),
    canUndo: false,
    canRedo: false,
    allWorkflows: [],
    setSelectedNodeId: vi.fn(),
    userIntegrations: [],
    publication: undefined,
  };
}

function baseActions(): WorkflowToolbarActions {
  return {
    handleSave: vi.fn(async () => {}),
    handleExecute: vi.fn(async () => {}),
    handleClearWorkflow: vi.fn(),
    handleDeleteWorkflow: vi.fn(),
    loadWorkflows: vi.fn(async () => {}),
    handleDuplicate: vi.fn(),
    isDuplicating: false,
    handlePublish: vi.fn(),
    confirmPublish: vi.fn(),
    isPublishing: false,
    isComparing: false,
    isPreflighting: false,
    publishReview: null,
    setPublishReviewOpen: vi.fn(),
    handleSetWorkflowMode: vi.fn(async () => {}),
  };
}

type ChromeProps = {
  actions: WorkflowToolbarActions;
  state: WorkflowToolbarState;
  workflowId?: string;
};

export function renderChrome(
  Chrome: React.ComponentType<ChromeProps>,
  lock: {
    overlayActive?: boolean;
    generating?: boolean;
    graph?: WorkflowToolbarState["nodes"];
    state?: Partial<WorkflowToolbarState>;
    /** Null is a draft nobody has saved yet, which has no id to act on. */
    workflowId?: string | undefined;
    /** What the palette's node-type page has to offer. */
    catalog?: ExtensionCatalog;
  } = {}
) {
  const store = createStore();
  // Built once per render of the harness, not once per render of the tree: an
  // inline `new QueryClient()` inside the route component hands every re-render
  // a fresh cache, which is a refetch loop the first case with a query would
  // find the hard way.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (lock.graph) {
    // "Tidy layout" reads the graph off the store rather than off the state
    // prop, because the pass it runs is the canvas's own.
    store.set(loadWorkflowGraphAtom, { nodes: lock.graph, edges: [] });
  }
  if (lock.overlayActive) {
    // The overlay is only on the canvas while the Runs workspace is, so both halves
    // of that state go in together.
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(executionOverlayGraphAtom, { nodes: [], edges: [] });
  }
  if (lock.generating) {
    store.set(isGeneratingAtom, true);
  }
  // Which workflow is open, as the loader would have written it. The palette
  // refuses to open without one, and the workflow menu's own draft case passes
  // `workflowId: undefined` to get exactly that.
  store.set(
    currentWorkflowIdAtom,
    ("workflowId" in lock ? lock.workflowId : "workflow_1") ?? null
  );
  store.set(isWorkflowOwnerAtom, lock.state?.isOwner ?? true);

  // Built once rather than inside the route component, so a case can assert on
  // the spy the chrome was actually handed: re-created per render, every click
  // would land on an object the test never saw.
  const actions = baseActions();
  const workflowId = "workflowId" in lock ? lock.workflowId : "workflow_1";

  // The toolbar calls `useNavigate` for the workflow switcher, so it needs a
  // router above it. One root route carries the whole tree, since no case here
  // reads a param or a search value; the toolbar is rendered directly rather
  // than reached by a path.
  const rootRoute = createRootRoute({
    component: () => (
      <JotaiProvider store={store}>
        {/* The workflow menu carries the create dialog, which is a mutation. */}
        <QueryClientProvider client={queryClient}>
          <ReactFlowProvider>
            {/* The Actions menu's "Tidy layout" runs a layout pass, which reads
              the catalog for what each node type measures. */}
            <ExtensionCatalogProvider value={lock.catalog ?? emptyCatalog}>
              <OverlayProvider>
                {/* A host the absence cases can wait for: asserting that nothing
                  rendered is only meaningful once the router has resolved its
                  route, and this element is on screen exactly then. */}
                <div data-testid="toolbar-actions-host">
                  <Chrome
                    actions={actions}
                    state={{ ...baseState(), ...lock.state }}
                    workflowId={workflowId}
                  />
                </div>
                {/* The production toolbar places these in separate left, centre,
                    and right groups. This harness keeps the existing focused
                    Actions tests while mounting the controls they coordinate. */}
                {Chrome === ToolbarActions && (lock.state?.isOwner ?? true) ? (
                  <>
                    <CommandPaletteTrigger />
                    <ToolbarPublishControls
                      actions={actions}
                      state={{ ...baseState(), ...lock.state }}
                    />
                  </>
                ) : null}
              </OverlayProvider>
            </ExtensionCatalogProvider>
          </ReactFlowProvider>
        </QueryClientProvider>
      </JotaiProvider>
    ),
  });

  return {
    ...render(
      <RouterProvider
        router={createRouter({
          routeTree: rootRoute,
          history: createMemoryHistory({
            initialEntries: ["/workflows/workflow_1"],
          }),
        })}
      />
    ),
    actions,
    store,
  };
}
