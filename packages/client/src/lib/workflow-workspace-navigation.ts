/**
 * The workspace address the editor route names, and the navigation each
 * address remembers. The route is the system of record for the active address;
 * the selection, Inspector state, and cameras stored here per address are
 * the system of record for those values. The UI and graph stores read this module.
 */

import { atom, type Getter } from "jotai";
import {
  withMobileSequenceFrom,
  type MobileSheet,
} from "#src/lib/mobile-sheet-navigation";
import {
  EMPTY_WORKFLOW_NAVIGATION,
  inspectionInGraph,
  rememberRouteSearch,
  revealFollowsSelection,
  workspaceNavigationAt,
  updateWorkspaceNavigation,
  withCamera,
  withDesktopRevealLevel,
  withInspectedOrigin,
  withInspectorDismissal,
  withInspectorScroll,
  withChosenExecution,
  withInspectedSelection,
  withShowSuperseded,
  withoutDraftSelections,
  workspaceAddressFromSearch,
  type CanvasSelection,
  type DesktopPresentation,
  type FormFactor,
  type InspectedOrigin,
  type NavigationGraph,
  type RevealLevel,
  type ChosenRunExecution,
  type WorkspaceNavigation,
  type WorkflowNavigation,
  type WorkflowRouteSearch,
  type WorkspaceAddress,
  type WorldCamera,
  EMPTY_SELECTION,
} from "#src/lib/workflow-navigation-state";
import { withSelection } from "#src/lib/canvas-selection";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";

type WorkspaceRoute = { workflowId: string; search: WorkflowRouteSearch };

const workspaceRouteStateAtom = atom<WorkspaceRoute | null>(null);

/** Navigation by workflow id. */
const workflowNavigationStateAtom = atom<
  ReadonlyMap<string, WorkflowNavigation>
>(new Map());

function navigationFor(get: Getter, workflowId: string): WorkflowNavigation {
  return (
    get(workflowNavigationStateAtom).get(workflowId) ??
    EMPTY_WORKFLOW_NAVIGATION
  );
}

/**
 * Replace the navigation of one workflow with `update`'s answer. Nothing is
 * written when `update` answers its input unchanged.
 */
const writeNavigationAtom = atom(
  null,
  (
    get,
    set,
    workflowId: string,
    update: (navigation: WorkflowNavigation) => WorkflowNavigation
  ) => {
    const current = navigationFor(get, workflowId);
    const next = update(current);
    if (next !== current) {
      const state = new Map(get(workflowNavigationStateAtom));
      state.set(workflowId, next);
      set(workflowNavigationStateAtom, state);
    }
  }
);

/**
 * Replace the remembered navigation of one address with `update`'s answer, for
 * the stores of one surface's navigation, such as the mobile sheets.
 */
export const updateAddressNavigationAtom = atom(
  null,
  (
    _get,
    set,
    address: WorkspaceAddress,
    update: (workspace: WorkspaceNavigation) => WorkspaceNavigation
  ) => {
    set(writeNavigationAtom, address.workflowId, (navigation) =>
      updateWorkspaceNavigation(navigation, address, update)
    );
  }
);

/** The navigation one address remembers, which need not be the active one. */
export function addressNavigation(
  get: Getter,
  address: WorkspaceAddress
): WorkspaceNavigation {
  return workspaceNavigationAt(navigationFor(get, address.workflowId), address);
}

/**
 * Apply the route the router committed: the workflow in the path and its
 * validated search. Records the search as the one its view returns to.
 *
 * The mobile Reveal sequence carries across addresses of Runs, whose sheets
 * show the address itself: when the previous address had a sheet open and the
 * next has none, the next opens its address sheet. Selecting a run, the newest
 * run opening by itself, Back to the run list, and a newly started run all
 * keep the sequence this way.
 */
export const applyWorkspaceRouteAtom = atom(
  null,
  (get, set, route: WorkspaceRoute) => {
    const previous = get(activeWorkspaceAddressAtom);
    const previousSheets = get(activeMobileSheetsAtom);
    set(workspaceRouteStateAtom, route);
    const next = workspaceAddressFromSearch(route.workflowId, route.search);
    const carriesSequence =
      previous.workflowId === next.workflowId &&
      previous.key.workspace === next.key.workspace &&
      !revealFollowsSelection(next.key.workspace);
    set(writeNavigationAtom, route.workflowId, (navigation) =>
      updateWorkspaceNavigation(
        rememberRouteSearch(navigation, next),
        next,
        (workspace) =>
          carriesSequence
            ? withMobileSequenceFrom(workspace, previousSheets)
            : workspace
      )
    );
  }
);

/**
 * The address the editor presents. The route names it once the route and the
 * hydrated workflow agree; until then the open workflow shows its Draft.
 */
export const activeWorkspaceAddressAtom = atom<WorkspaceAddress>((get) => {
  const workflowId = get(currentWorkflowIdAtom) ?? "";
  const route = get(workspaceRouteStateAtom);
  return workspaceAddressFromSearch(
    workflowId,
    route?.workflowId === workflowId ? route.search : {}
  );
});

/**
 * The route search each view of the open workflow last showed. A view with no
 * entry has not been visited in this session.
 */
export const rememberedRouteSearchesAtom = atom(
  (get): WorkflowNavigation["searches"] => {
    const workflowId = get(currentWorkflowIdAtom);
    return workflowId
      ? navigationFor(get, workflowId).searches
      : EMPTY_WORKFLOW_NAVIGATION.searches;
  }
);

const activeWorkspaceNavigationAtom = atom((get): WorkspaceNavigation => {
  const address = get(activeWorkspaceAddressAtom);
  return workspaceNavigationAt(navigationFor(get, address.workflowId), address);
});

/**
 * The selected nodes and edges of the active address. Every canvas paints its
 * React Flow `selected` flags from this value, and writing it never touches
 * the graph, its undo history, or its save.
 */
export const activeSelectionAtom = atom(
  (get) => get(activeWorkspaceNavigationAtom).selection,
  (get, set, selection: CanvasSelection) => {
    set(setWorkspaceSelectionAtom, {
      address: get(activeWorkspaceAddressAtom),
      selection,
    });
  }
);

/**
 * Set the selection of a named address, which need not be the active one. In a
 * workspace that follows its selection, a selection that comes to hold one
 * object becomes the object the Inspector inspects.
 */
export const setWorkspaceSelectionAtom = atom(
  null,
  (
    _get,
    set,
    input: { address: WorkspaceAddress; selection: CanvasSelection }
  ) => {
    const write = revealFollowsSelection(input.address.key.workspace)
      ? withInspectedSelection
      : withSelection;
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateWorkspaceNavigation(navigation, input.address, (workspace) =>
        write(workspace, input.selection)
      )
    );
  }
);

/**
 * Empty the selection of every Draft address of one workflow, as when its
 * Draft graph is loaded. A run address presents the graph its run
 * pinned, so its selection stays. Takes the workflow id so a load that runs
 * before the workflow becomes the current one clears that workflow and no
 * other.
 */
export const clearDraftSelectionsAtom = atom(
  null,
  (_get, set, workflowId: string) => {
    set(writeNavigationAtom, workflowId, withoutDraftSelections);
  }
);

/**
 * The level the desktop Inspector shows the active address at. An address
 * that never set one shows Browse.
 */
export const activeDesktopRevealLevelAtom = atom(
  (get): RevealLevel =>
    get(activeWorkspaceNavigationAtom).desktop.revealLevel ?? "browse"
);

/** The desktop Inspector state stored for the active address. */
export const activeRevealPresentationAtom = atom(
  (get): DesktopPresentation => get(activeWorkspaceNavigationAtom).desktop
);

/** Set the desktop Inspector level of a named address. */
export const setWorkspaceRevealLevelAtom = atom(
  null,
  (_get, set, input: { address: WorkspaceAddress; level: RevealLevel }) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateWorkspaceNavigation(navigation, input.address, (workspace) =>
        withDesktopRevealLevel(workspace, input.level)
      )
    );
  }
);

/**
 * Record that the person closed the Inspector card of a named address on the
 * subject whose key is `subjectKey`.
 */
export const recordInspectorDismissalAtom = atom(
  null,
  (_get, set, input: { address: WorkspaceAddress; subjectKey: string }) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateWorkspaceNavigation(navigation, input.address, (workspace) =>
        withInspectorDismissal(workspace, input.subjectKey)
      )
    );
  }
);

/**
 * Open the Inspector card of a named address again after its X or Escape
 * closed it, as every press on a step does: on its card, its outline row,
 * Enter on its card, or a search for it.
 */
export const openInspectorAtom = atom(
  null,
  (_get, set, address: WorkspaceAddress) => {
    set(writeNavigationAtom, address.workflowId, (navigation) =>
      updateWorkspaceNavigation(navigation, address, (workspace) =>
        withInspectorDismissal(workspace, null)
      )
    );
  }
);

/**
 * Record the inspector scroll of one level for a named address. The write
 * is dropped when the address no longer inspects the node `inspectedId` names,
 * so a scroll read before a selection change never lands on the next object. A
 * null `inspectedId` is the scroll of an address that inspects no object, such
 * as a run list or a run.
 */
export const recordInspectorScrollAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      inspectedId: string | null;
      level: RevealLevel;
      top: number;
    }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateWorkspaceNavigation(navigation, input.address, (workspace) =>
        (workspace.desktop.inspected?.id ?? null) === input.inspectedId
          ? withInspectorScroll(workspace, input.level, input.top)
          : workspace
      )
    );
  }
);

/**
 * Select the node `nodeId` alone in a named address and record `origin` as
 * where the jump started, in one navigation write.
 */
export const openNodeRevealFromOriginAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      nodeId: string;
      origin: InspectedOrigin;
    }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateWorkspaceNavigation(navigation, input.address, (workspace) =>
        selectFromOrigin(workspace, input)
      )
    );
  }
);

/** Select `nodeId` alone, then record `origin` as where the jump started. */
function selectFromOrigin(
  workspace: WorkspaceNavigation,
  input: {
    address: WorkspaceAddress;
    nodeId: string;
    origin: InspectedOrigin;
  }
): WorkspaceNavigation {
  const select = revealFollowsSelection(input.address.key.workspace)
    ? withInspectedSelection
    : withSelection;
  const selected = select(workspace, { nodeIds: [input.nodeId], edgeIds: [] });
  return withInspectedOrigin(selected, input.origin);
}

/** Forget the active address's inspected object when the graph lost it. */
export const keepActiveInspectionInGraphAtom = atom(
  null,
  (get, set, graph: NavigationGraph) => {
    const address = get(activeWorkspaceAddressAtom);
    set(writeNavigationAtom, address.workflowId, (navigation) =>
      updateWorkspaceNavigation(navigation, address, (workspace) =>
        inspectionInGraph(workspace, graph)
      )
    );
  }
);

/**
 * Whether the active run list shows superseded runs. Each run list address
 * keeps its own value, so a return to that list restores it.
 */
export const activeShowSupersededAtom = atom(
  (get) => get(activeWorkspaceNavigationAtom).showSuperseded,
  (get, set, showSuperseded: boolean) => {
    const address = get(activeWorkspaceAddressAtom);
    set(writeNavigationAtom, address.workflowId, (navigation) =>
      updateWorkspaceNavigation(navigation, address, (workspace) =>
        withShowSuperseded(workspace, showSuperseded)
      )
    );
  }
);

/** The run node execution chosen in the active address, or null. */
export const activeChosenExecutionAtom = atom(
  (get): ChosenRunExecution | null =>
    get(activeWorkspaceNavigationAtom).chosenExecution
);

/**
 * Show the evidence of one run node in a named run address, in one navigation
 * write. `selectsNode` selects the node alone, and otherwise the selection is
 * emptied, for a node the address's canvas cannot select. A non-null
 * `executionLogId` records that execution as the chosen one. `opensFocus` shows
 * the node's evidence in the Inspector.
 */
export const inspectRunNodeAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      nodeId: string;
      executionLogId: string | null;
      selectsNode: boolean;
      opensFocus: boolean;
    }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateWorkspaceNavigation(navigation, input.address, (workspace) => {
        const selected = withSelection(
          workspace,
          input.selectsNode
            ? { nodeIds: [input.nodeId], edgeIds: [] }
            : EMPTY_SELECTION
        );
        const chosen =
          input.executionLogId === null
            ? selected
            : withChosenExecution(selected, {
                nodeId: input.nodeId,
                logId: input.executionLogId,
              });
        return input.opensFocus
          ? withDesktopRevealLevel(chosen, "focus")
          : chosen;
      })
    );
  }
);

/**
 * Stop showing run node evidence in the active address: nothing is selected and
 * no execution is chosen.
 */
export const clearRunNodeInspectionAtom = atom(null, (get, set) => {
  const address = get(activeWorkspaceAddressAtom);
  set(writeNavigationAtom, address.workflowId, (navigation) =>
    updateWorkspaceNavigation(navigation, address, (workspace) =>
      withChosenExecution(withSelection(workspace, EMPTY_SELECTION), null)
    )
  );
});

/**
 * Choose which recorded execution of a run node the active address shows. The
 * canvas selection is left as it is.
 */
export const chooseRunExecutionAtom = atom(
  null,
  (get, set, chosen: ChosenRunExecution) => {
    const address = get(activeWorkspaceAddressAtom);
    set(writeNavigationAtom, address.workflowId, (navigation) =>
      updateWorkspaceNavigation(navigation, address, (workspace) =>
        withChosenExecution(workspace, chosen)
      )
    );
  }
);

/** The mobile Reveal sheets open in the active address, the first opened first. */
export const activeMobileSheetsAtom = atom(
  (get): readonly MobileSheet[] =>
    get(activeWorkspaceNavigationAtom).mobile.sheets
);

/** The camera saved for each form factor of the active address. */
export const activeWorkspaceCamerasAtom = atom(
  (get): Readonly<Record<FormFactor, WorldCamera | null>> => {
    const workspace = get(activeWorkspaceNavigationAtom);
    return {
      desktop: workspace.desktop.camera,
      mobile: workspace.mobile.camera,
    };
  }
);

/** Store the camera one form factor showed for a named address. */
export const recordWorkspaceCameraAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      formFactor: FormFactor;
      camera: WorldCamera;
    }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateWorkspaceNavigation(navigation, input.address, (workspace) =>
        withCamera(workspace, input.formFactor, input.camera)
      )
    );
  }
);

/** Drop everything remembered for a workflow, as when it is deleted. */
export const forgetWorkflowNavigationAtom = atom(
  null,
  (get, set, workflowId: string) => {
    const state = get(workflowNavigationStateAtom);
    if (state.has(workflowId)) {
      const next = new Map(state);
      next.delete(workflowId);
      set(workflowNavigationStateAtom, next);
    }
  }
);
