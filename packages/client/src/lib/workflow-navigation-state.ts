/**
 * Restorable editor navigation, kept apart from the workflow definition. The
 * editor route search names one workspace address; the values here are what
 * each address remembers between visits. Every function is pure and answers
 * its input unchanged when nothing needed to change.
 */

import { mapOrSame } from "@wfgraph/shared/utils/map-or-same";
import {
  sameObject,
  selectedObject,
  withSelection,
} from "#src/lib/canvas-selection";
import {
  mobileSheetsInGraph,
  objectInGraph,
  withMobileSummaryOf,
  withoutMobileSheets,
  type MobilePresentation,
} from "#src/lib/mobile-sheet-navigation";

export type WorkspaceView = "draft" | "runs";

/**
 * The editor route search. `view` names Runs, and an absent `view` is Draft.
 * `executionId` belongs to Runs. `review` asks Draft to open the review sheet
 * once, which the editor answers and then drops from the route. `group` is
 * only ever read from an older link, which named a Group the editor once
 * showed on a canvas of its own: the editor selects that Group's first step
 * and drops the key.
 */
export type WorkflowRouteSearch = {
  view?: "runs" | undefined;
  executionId?: string | undefined;
  group?: string | undefined;
  review?: true | undefined;
};

/** Draft, or the run list or one run. A null `executionId` is the run list. */
export type WorkspaceKey =
  | { workspace: "draft" }
  | { workspace: "runs"; executionId: string | null };

/** Whether `key` is the run list: Runs with no run open. */
export function showsRunList(key: WorkspaceKey): boolean {
  return key.workspace === "runs" && key.executionId === null;
}

/** One workspace key inside one workflow. */
export type WorkspaceAddress = {
  workflowId: string;
  key: WorkspaceKey;
};

export type FormFactor = "desktop" | "mobile";

/** The flow-coordinate point at the middle of the canvas, and the zoom there. */
export type WorldCamera = { centerX: number; centerY: number; zoom: number };

/**
 * What the desktop Inspector shows in Runs: a run at Browse, and a run
 * node's evidence at Focus. A Draft object offers Browse
 * alone, which holds its editable form.
 */
export type RevealLevel = "browse" | "focus";

/**
 * Whether a selection decides what the Inspector inspects in a
 * workspace. Draft follows its selection; a run address inspects the node
 * whose evidence it shows.
 */
export function revealFollowsSelection(workspace: WorkspaceView): boolean {
  return workspace === "draft";
}

/** The one node or edge the Inspector shows. */
export type InspectedObject = { kind: "node" | "edge"; id: string };

/**
 * The node the Inspector jumped from to reach the inspected object, which
 * Back returns to by selecting it again.
 */
export type InspectedOrigin = { nodeId: string };

/**
 * The nodes and edges selected in one address, by id, each id listed once.
 * React Flow's `selected` flags on the canvas are painted from this value.
 */
export type CanvasSelection = {
  nodeIds: readonly string[];
  edgeIds: readonly string[];
};

/** One React Flow `select` change: an id and whether it is now selected. */
export type SelectionChange = { id: string; selected: boolean };

/** What one form factor shows for one address. */
export type FormFactorPresentation = { camera: WorldCamera | null };

/**
 * The desktop presentation adds the Inspector. A null `revealLevel`
 * belongs to an address that has never set one, which shows Browse. `inspected`
 * is the object `inspectorScroll` (pixels from the top, per level) belongs to.
 * `inspectedOrigin` is where a jump to `inspected` started. It lasts while the
 * selection holds `inspected` alone. `dismissedSubjectKey` is the key of the
 * Inspector subject the person closed the card on with its X or Escape; the
 * card stays closed while the address's subject has that key. A selection
 * change and an explicit open forget it.
 */
export type DesktopPresentation = FormFactorPresentation & {
  revealLevel: RevealLevel | null;
  inspected: InspectedObject | null;
  inspectorScroll: Readonly<Record<RevealLevel, number>>;
  inspectedOrigin: InspectedOrigin | null;
  dismissedSubjectKey: string | null;
};

/**
 * The execution a person chose among the recorded executions of one run node:
 * the node's id and the id of that execution's run-log row. The engine writes
 * one row each time a run reaches the node, and a retry inside one execution
 * closes that same row again.
 */
export type ChosenRunExecution = { nodeId: string; logId: string };

/**
 * `showSuperseded` is whether a run list shows the runs a newer start
 * superseded, on either form factor. Only a run list address reads it.
 * `chosenExecution` is the execution chosen for the run node whose evidence a run
 * address shows. It belongs to the node the selection holds alone, or, with
 * nothing selected, to a node no canvas selection can hold, such as one the
 * run's graph lacks. Only a run address writes it.
 */
export type WorkspaceNavigation = {
  selection: CanvasSelection;
  desktop: DesktopPresentation;
  mobile: MobilePresentation;
  showSuperseded: boolean;
  chosenExecution: ChosenRunExecution | null;
};

export type WorkflowNavigation = {
  /** Keyed by `workspaceKeyId`, least recently written first. */
  workspaces: ReadonlyMap<string, WorkspaceNavigation>;
  /**
   * The route search each view last showed, which switching back to that view
   * navigates to. The Runs search is the run a Runs visit reopens. A view with
   * no entry has not been visited.
   */
  searches: Readonly<Partial<Record<WorkspaceView, WorkflowRouteSearch>>>;
};

/** The graph facts recovery needs: which nodes and edges exist. */
export type NavigationGraph = {
  nodes: ReadonlyArray<{
    id: string;
    parentId?: string | undefined;
    data: { type: string };
  }>;
  edges: ReadonlyArray<{ id: string; target: string }>;
};

/** How many run keys one workflow retains besides the run Runs reopens. */
export const RETAINED_KEYS_PER_VIEW = 10;

export const EMPTY_SELECTION: CanvasSelection = { nodeIds: [], edgeIds: [] };

export const EMPTY_WORKSPACE_NAVIGATION: WorkspaceNavigation = {
  selection: EMPTY_SELECTION,
  desktop: {
    camera: null,
    revealLevel: null,
    inspected: null,
    inspectorScroll: { browse: 0, focus: 0 },
    inspectedOrigin: null,
    dismissedSubjectKey: null,
  },
  mobile: { camera: null, sheets: [] },
  showSuperseded: false,
  chosenExecution: null,
};

export const EMPTY_WORKFLOW_NAVIGATION: WorkflowNavigation = {
  workspaces: new Map(),
  searches: {},
};

const DRAFT_KEY_ID = "draft";

/** A stable string for a workspace key. Ids cannot collide across kinds. */
export function workspaceKeyId(key: WorkspaceKey): string {
  if (key.workspace === "draft") {
    return DRAFT_KEY_ID;
  }
  return key.executionId === null ? "runs" : `run:${key.executionId}`;
}

export function workspaceAddressId(address: WorkspaceAddress): string {
  return `${address.workflowId}|${workspaceKeyId(address.key)}`;
}

/** The address a validated route search names inside one workflow. */
export function workspaceAddressFromSearch(
  workflowId: string,
  search: WorkflowRouteSearch
): WorkspaceAddress {
  const key: WorkspaceKey =
    search.view === "runs"
      ? { workspace: "runs", executionId: search.executionId ?? null }
      : { workspace: "draft" };
  return { workflowId, key };
}

/** The route search that names one address, with no undefined keys. */
export function workspaceRouteSearch(
  address: WorkspaceAddress
): WorkflowRouteSearch {
  const { key } = address;
  const search: WorkflowRouteSearch = {};
  if (key.workspace === "runs") {
    search.view = "runs";
    if (key.executionId !== null) {
      search.executionId = key.executionId;
    }
  }
  return search;
}

export function sameRouteSearch(
  left: WorkflowRouteSearch,
  right: WorkflowRouteSearch
): boolean {
  return (
    left.view === right.view &&
    left.executionId === right.executionId &&
    left.group === right.group &&
    left.review === right.review
  );
}

/** The navigation stored for one address, or the empty navigation. */
export function workspaceNavigationAt(
  navigation: WorkflowNavigation,
  address: WorkspaceAddress
): WorkspaceNavigation {
  return (
    navigation.workspaces.get(workspaceKeyId(address.key)) ??
    EMPTY_WORKSPACE_NAVIGATION
  );
}

/**
 * Apply `update` to the navigation of one address. A written key moves to the
 * end of the recency order. Run keys past `RETAINED_KEYS_PER_VIEW` are dropped
 * oldest first, keeping the one Runs reopens.
 */
export function updateWorkspaceNavigation(
  navigation: WorkflowNavigation,
  address: WorkspaceAddress,
  update: (workspace: WorkspaceNavigation) => WorkspaceNavigation
): WorkflowNavigation {
  const current = workspaceNavigationAt(navigation, address);
  const next = update(current);
  if (next === current) {
    return navigation;
  }
  const keyId = workspaceKeyId(address.key);
  const workspaces = new Map(navigation.workspaces);
  workspaces.delete(keyId);
  workspaces.set(keyId, next);
  return {
    ...navigation,
    workspaces: evictOldKeys(workspaces, navigation.searches),
  };
}

/**
 * Drop the oldest run keys past the retained count. The key Runs' remembered
 * search names is kept whatever its age.
 */
function evictOldKeys(
  workspaces: Map<string, WorkspaceNavigation>,
  searches: WorkflowNavigation["searches"]
): Map<string, WorkspaceNavigation> {
  const reopened = searches.runs
    ? workspaceKeyId(workspaceAddressFromSearch("", searches.runs).key)
    : null;
  const evictable = [...workspaces.keys()].filter(
    (keyId) => keyId.startsWith("run:") && keyId !== reopened
  );
  for (const keyId of evictable.slice(
    0,
    Math.max(0, evictable.length - RETAINED_KEYS_PER_VIEW)
  )) {
    workspaces.delete(keyId);
  }
  return workspaces;
}

/** Record the route search an address's view is showing. */
export function rememberRouteSearch(
  navigation: WorkflowNavigation,
  address: WorkspaceAddress
): WorkflowNavigation {
  const view = address.key.workspace;
  const search = workspaceRouteSearch(address);
  const remembered = navigation.searches[view];
  if (remembered && sameRouteSearch(remembered, search)) {
    return navigation;
  }
  return {
    ...navigation,
    searches: { ...navigation.searches, [view]: search },
  };
}

export function withChosenExecution(
  workspace: WorkspaceNavigation,
  chosenExecution: ChosenRunExecution | null
): WorkspaceNavigation {
  return workspace.chosenExecution?.nodeId === chosenExecution?.nodeId &&
    workspace.chosenExecution?.logId === chosenExecution?.logId
    ? workspace
    : { ...workspace, chosenExecution };
}

function idsWithChanges(
  ids: readonly string[],
  changes: readonly SelectionChange[]
): readonly string[] {
  const next = new Set(ids);
  for (const change of changes) {
    if (change.selected) {
      next.add(change.id);
    } else {
      next.delete(change.id);
    }
  }
  return next.size === ids.length && ids.every((id) => next.has(id))
    ? ids
    : [...next];
}

/**
 * The selection after React Flow's `select` changes for nodes and for edges.
 * Answers `selection` itself when the changes leave it as it was.
 */
export function selectionWithChanges(
  selection: CanvasSelection,
  changes: {
    nodes?: readonly SelectionChange[] | undefined;
    edges?: readonly SelectionChange[] | undefined;
  }
): CanvasSelection {
  const nodeIds = idsWithChanges(selection.nodeIds, changes.nodes ?? []);
  const edgeIds = idsWithChanges(selection.edgeIds, changes.edges ?? []);
  return nodeIds === selection.nodeIds && edgeIds === selection.edgeIds
    ? selection
    : { nodeIds, edgeIds };
}

/**
 * The selection without the ids a graph does not hold. Answers `selection`
 * itself when every id is still there.
 */
export function selectionInGraph(
  selection: CanvasSelection,
  graph: NavigationGraph
): CanvasSelection {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const keptNodeIds = selection.nodeIds.filter((id) => nodeIds.has(id));
  const keptEdgeIds = selection.edgeIds.filter((id) => edgeIds.has(id));
  return keptNodeIds.length === selection.nodeIds.length &&
    keptEdgeIds.length === selection.edgeIds.length
    ? selection
    : { nodeIds: keptNodeIds, edgeIds: keptEdgeIds };
}

/**
 * The navigation with the selection emptied in the Draft key, the key a Draft
 * graph load replaces the graph of. Run keys keep their
 * selections, and every key keeps its cameras, levels, remembered searches,
 * and order.
 */
export function withoutDraftSelections(
  navigation: WorkflowNavigation
): WorkflowNavigation {
  const entries = [...navigation.workspaces];
  const cleared = mapOrSame(entries, (item): [string, WorkspaceNavigation] => {
    const [keyId, entry] = item;
    if (keyId !== DRAFT_KEY_ID) {
      return item;
    }
    const next = withoutSelection(entry);
    return next === entry ? item : [keyId, next];
  });
  return cleared === entries
    ? navigation
    : { ...navigation, workspaces: new Map(cleared) };
}

/** The workspace with nothing selected and no mobile sheet open. */
function withoutSelection(workspace: WorkspaceNavigation): WorkspaceNavigation {
  return withoutMobileSheets(withSelection(workspace, EMPTY_SELECTION));
}

/** Set the level the desktop Inspector shows Runs at. */
export function withDesktopRevealLevel(
  workspace: WorkspaceNavigation,
  revealLevel: RevealLevel
): WorkspaceNavigation {
  return workspace.desktop.revealLevel === revealLevel
    ? workspace
    : { ...workspace, desktop: { ...workspace.desktop, revealLevel } };
}

/**
 * Write a Draft selection and inspect what it holds on both form factors.
 * When the selection comes to hold one object it did not hold alone before,
 * the mobile sequence starts over at that object's summary sheet. A different
 * object than the one inspected becomes the inspected object, and its
 * inspector scroll and way back start over. A selection holding no
 * single object closes the mobile sheets.
 */
export function withInspectedSelection(
  workspace: WorkspaceNavigation,
  selection: CanvasSelection
): WorkspaceNavigation {
  const selected = selectedObject(selection);
  if (selected === null) {
    return withoutMobileSheets(withSelection(workspace, selection));
  }
  if (sameObject(selectedObject(workspace.selection), selected)) {
    return withSelection(workspace, selection);
  }
  const withNext = withMobileSummaryOf(
    withSelection(workspace, selection),
    selected
  );
  if (sameObject(workspace.desktop.inspected, selected)) {
    return withNext;
  }
  return {
    ...withNext,
    desktop: {
      ...withNext.desktop,
      inspected: selected,
      inspectorScroll: EMPTY_WORKSPACE_NAVIGATION.desktop.inspectorScroll,
      inspectedOrigin: null,
    },
  };
}

/** Record how far the inspector at one level is scrolled. */
export function withInspectorScroll(
  workspace: WorkspaceNavigation,
  level: RevealLevel,
  top: number
): WorkspaceNavigation {
  const stored = workspace.desktop.inspectorScroll;
  return stored[level] === top
    ? workspace
    : {
        ...workspace,
        desktop: {
          ...workspace.desktop,
          inspectorScroll: { ...stored, [level]: top },
        },
      };
}

export function withShowSuperseded(
  workspace: WorkspaceNavigation,
  showSuperseded: boolean
): WorkspaceNavigation {
  return workspace.showSuperseded === showSuperseded
    ? workspace
    : { ...workspace, showSuperseded };
}

/**
 * Record the key of the Inspector subject whose card the person closed, or
 * null to open the card again.
 */
export function withInspectorDismissal(
  workspace: WorkspaceNavigation,
  dismissedSubjectKey: string | null
): WorkspaceNavigation {
  return workspace.desktop.dismissedSubjectKey === dismissedSubjectKey
    ? workspace
    : { ...workspace, desktop: { ...workspace.desktop, dismissedSubjectKey } };
}

/** Record where a jump to the inspected object started. */
export function withInspectedOrigin(
  workspace: WorkspaceNavigation,
  inspectedOrigin: InspectedOrigin | null
): WorkspaceNavigation {
  return workspace.desktop.inspectedOrigin === inspectedOrigin
    ? workspace
    : { ...workspace, desktop: { ...workspace.desktop, inspectedOrigin } };
}

/**
 * The workspace without an inspected object the graph no longer holds, and without
 * the scroll recorded for it, on either form factor.
 */
export function inspectionInGraph(
  workspace: WorkspaceNavigation,
  graph: NavigationGraph
): WorkspaceNavigation {
  const withSheets = mobileSheetsInGraph(workspace, graph);
  const { inspected } = withSheets.desktop;
  if (inspected === null || objectInGraph(inspected, graph)) {
    return withSheets;
  }
  return {
    ...withSheets,
    desktop: {
      ...withSheets.desktop,
      inspected: null,
      inspectorScroll: EMPTY_WORKSPACE_NAVIGATION.desktop.inspectorScroll,
      inspectedOrigin: null,
    },
  };
}

export function withCamera(
  workspace: WorkspaceNavigation,
  formFactor: FormFactor,
  camera: WorldCamera
): WorkspaceNavigation {
  const stored = workspace[formFactor].camera;
  if (
    stored?.centerX === camera.centerX &&
    stored.centerY === camera.centerY &&
    stored.zoom === camera.zoom
  ) {
    return workspace;
  }
  return formFactor === "desktop"
    ? { ...workspace, desktop: { ...workspace.desktop, camera } }
    : { ...workspace, mobile: { ...workspace.mobile, camera } };
}

/**
 * The route search recovery settles on for what the editor could open. It
 * never keeps an older link's `group`, and `runMissing` returns Runs to the
 * run list.
 */
export function recoveredRouteSearch(input: {
  search: WorkflowRouteSearch;
  runMissing: boolean;
}): WorkflowRouteSearch {
  const { search } = input;
  const next: WorkflowRouteSearch = { ...search };
  delete next.group;
  if (
    search.view === "runs" &&
    input.runMissing &&
    search.executionId !== undefined
  ) {
    delete next.executionId;
  }
  return sameRouteSearch(next, search) ? search : next;
}

export type CameraSlot = { addressId: string; formFactor: FormFactor };

/**
 * What the canvas does with its camera when the slot it presents changes.
 *
 * `shown` is the slot whose camera the viewport holds, and `moving` says a pan,
 * zoom, or animation has not ended. `shownPlaced` and `nextPlaced` say the
 * canvas has made its first placement for each slot's workflow. The shown
 * camera is recorded unless it is mid-movement or unplaced. The next slot's
 * saved camera is restored once placed; with none, the viewport stays put.
 */
export function cameraStep(input: {
  shown: CameraSlot | null;
  next: CameraSlot;
  moving: boolean;
  shownPlaced: boolean;
  nextPlaced: boolean;
  savedForNext: WorldCamera | null;
}): { recordShown: boolean; restore: WorldCamera | null } {
  const { shown, next } = input;
  if (
    shown?.addressId === next.addressId &&
    shown.formFactor === next.formFactor
  ) {
    return { recordShown: false, restore: null };
  }
  return {
    recordShown: shown !== null && input.shownPlaced && !input.moving,
    restore: input.nextPlaced ? input.savedForNext : null,
  };
}
