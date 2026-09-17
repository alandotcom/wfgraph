/**
 * Restorable editor navigation, kept apart from the workflow definition. The
 * editor route search names one workspace address; the values here are what
 * each address remembers between visits. Every function is pure and answers
 * its input unchanged when nothing needed to change.
 */

import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
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
  type MobileScopePresentation,
} from "#src/lib/mobile-sheet-navigation";

export type WorkspaceView = "draft" | "runs" | "changes";

/**
 * The editor route search. `view` names Runs or Changes, and an absent `view`
 * is Draft. `executionId` belongs to Runs, `compare` (a base version id) to
 * Changes, and `group` names the Group any workspace is focused on.
 */
export type WorkflowRouteSearch = {
  view?: "runs" | "changes" | undefined;
  executionId?: string | undefined;
  compare?: string | undefined;
  group?: string | undefined;
};

/**
 * Draft, the run list or one run, or the comparison against one base version.
 * A null `executionId` is the run list. A null `baseVersionId` is a
 * comparison whose base the route does not name yet, or a first publication.
 */
export type WorkspaceKey =
  | { workspace: "draft" }
  | { workspace: "runs"; executionId: string | null }
  | { workspace: "changes"; baseVersionId: string | null };

export type WorkspaceScope =
  | { kind: "overview" }
  | { kind: "group"; groupId: string };

/** One scope of one workspace key inside one workflow. */
export type WorkspaceAddress = {
  workflowId: string;
  key: WorkspaceKey;
  scope: WorkspaceScope;
};

export type FormFactor = "desktop" | "mobile";

/** The flow-coordinate point at the middle of the canvas, and the zoom there. */
export type WorldCamera = { centerX: number; centerY: number; zoom: number };

/**
 * Canvas Reveal's presentation states on desktop. Closed shows only the canvas,
 * Browse a compact summary beside it, and Focus the complete editor.
 */
export type RevealLevel = "closed" | "browse" | "focus";

export type OpenRevealLevel = Exclude<RevealLevel, "closed">;

/**
 * Whether a selection opens and closes Canvas Reveal in a workspace. Draft
 * follows its selection, and a Draft address starts closed. Runs and Changes
 * open and close at the level a person last chose, which a cookie keeps.
 */
export function revealFollowsSelection(workspace: WorkspaceView): boolean {
  return workspace === "draft";
}

/** The one node or edge Canvas Reveal shows. */
export type InspectedObject = { kind: "node" | "edge"; id: string };

/**
 * The node Canvas Reveal jumped from to reach the inspected object, which Back
 * returns to by selecting it again.
 */
export type InspectedOrigin = { nodeId: string };

/**
 * The nodes and edges selected in one scope, by id, each id listed once. React
 * Flow's `selected` flags on the canvas are painted from this value.
 */
export type CanvasSelection = {
  nodeIds: readonly string[];
  edgeIds: readonly string[];
};

/** One React Flow `select` change: an id and whether it is now selected. */
export type SelectionChange = { id: string; selected: boolean };

/** What one form factor shows for one scope. */
export type ScopePresentation = { camera: WorldCamera | null };

/**
 * The desktop presentation adds Canvas Reveal. A null `revealLevel` belongs to
 * a scope that has never been shown. `reopenLevel` is the level a newly
 * selected object opens at. `inspected` is the object the stored level,
 * `inspectorScroll` (pixels from the top, per open level), and
 * `inspectorSection` belong to. `inspectorSection` is the id of the Focus
 * section a sectioned inspector shows, and null shows its first section.
 * `inspectedOrigin` is where a jump to `inspected` started. It lasts while
 * Reveal stays open and the selection holds `inspected` alone.
 */
export type DesktopScopePresentation = ScopePresentation & {
  revealLevel: RevealLevel | null;
  reopenLevel: OpenRevealLevel;
  inspected: InspectedObject | null;
  inspectorScroll: Readonly<Record<OpenRevealLevel, number>>;
  inspectorSection: string | null;
  inspectedOrigin: InspectedOrigin | null;
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
export type ScopeNavigation = {
  selection: CanvasSelection;
  desktop: DesktopScopePresentation;
  mobile: MobileScopePresentation;
  showSuperseded: boolean;
  chosenExecution: ChosenRunExecution | null;
};

/** A key's overview scope and the one focused Group scope it last held. */
export type WorkspaceNavigation = {
  overview: ScopeNavigation;
  group: { groupId: string; navigation: ScopeNavigation } | null;
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
  /**
   * Whether a route has named a run of this workflow in this session. Runs
   * opens the newest run by itself only while this is false.
   */
  hasNamedRun: boolean;
};

/** The graph facts recovery needs: which nodes, Groups, and edges exist. */
export type NavigationGraph = {
  nodes: ReadonlyArray<{
    id: string;
    parentId?: string | undefined;
    data: { type: string };
  }>;
  edges: ReadonlyArray<{ id: string; target: string }>;
};

/**
 * How many run keys, and separately how many comparison keys, one workflow
 * retains besides the run Runs reopens and the comparison Changes reopens.
 */
export const RETAINED_KEYS_PER_VIEW = 10;

const OVERVIEW_SCOPE: WorkspaceScope = { kind: "overview" };

export const EMPTY_SELECTION: CanvasSelection = { nodeIds: [], edgeIds: [] };

export const EMPTY_SCOPE_NAVIGATION: ScopeNavigation = {
  selection: EMPTY_SELECTION,
  desktop: {
    camera: null,
    revealLevel: null,
    reopenLevel: "browse",
    inspected: null,
    inspectorScroll: { browse: 0, focus: 0 },
    inspectorSection: null,
    inspectedOrigin: null,
  },
  mobile: { camera: null, sheets: [] },
  showSuperseded: false,
  chosenExecution: null,
};

export const EMPTY_WORKFLOW_NAVIGATION: WorkflowNavigation = {
  workspaces: new Map(),
  searches: {},
  hasNamedRun: false,
};

const DRAFT_KEY_ID = "draft";
const COMPARISON_KEY_ID_PREFIX = "comparison:";

/** A stable string for a workspace key. Ids cannot collide across kinds. */
export function workspaceKeyId(key: WorkspaceKey): string {
  if (key.workspace === "draft") {
    return DRAFT_KEY_ID;
  }
  if (key.workspace === "runs") {
    return key.executionId === null ? "runs" : `run:${key.executionId}`;
  }
  return `${COMPARISON_KEY_ID_PREFIX}${key.baseVersionId ?? ""}`;
}

/**
 * Whether a workspace key presents the Draft graph or a comparison diffed
 * against it. A run key presents the graph its run pinned.
 */
function keyIdPresentsDraft(keyId: string): boolean {
  return keyId === DRAFT_KEY_ID || keyId.startsWith(COMPARISON_KEY_ID_PREFIX);
}

export function scopeId(scope: WorkspaceScope): string {
  return scope.kind === "overview" ? "overview" : `group:${scope.groupId}`;
}

export function workspaceAddressId(address: WorkspaceAddress): string {
  return `${address.workflowId}|${workspaceKeyId(address.key)}|${scopeId(address.scope)}`;
}

/** The address a validated route search names inside one workflow. */
export function workspaceAddressFromSearch(
  workflowId: string,
  search: WorkflowRouteSearch
): WorkspaceAddress {
  const key: WorkspaceKey =
    search.view === "runs"
      ? { workspace: "runs", executionId: search.executionId ?? null }
      : search.view === "changes"
        ? { workspace: "changes", baseVersionId: search.compare ?? null }
        : { workspace: "draft" };
  const scope: WorkspaceScope =
    search.group === undefined
      ? OVERVIEW_SCOPE
      : { kind: "group", groupId: search.group };
  return { workflowId, key, scope };
}

/** The route search that names one address, with no undefined keys. */
export function workspaceRouteSearch(
  address: WorkspaceAddress
): WorkflowRouteSearch {
  const { key, scope } = address;
  const search: WorkflowRouteSearch = {};
  if (key.workspace === "runs") {
    search.view = "runs";
    if (key.executionId !== null) {
      search.executionId = key.executionId;
    }
  }
  if (key.workspace === "changes") {
    search.view = "changes";
    if (key.baseVersionId !== null) {
      search.compare = key.baseVersionId;
    }
  }
  if (scope.kind === "group") {
    search.group = scope.groupId;
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
    left.compare === right.compare &&
    left.group === right.group
  );
}

/** The navigation stored for one address, or the empty navigation. */
export function scopeNavigationAt(
  navigation: WorkflowNavigation,
  address: WorkspaceAddress
): ScopeNavigation {
  const entry = navigation.workspaces.get(workspaceKeyId(address.key));
  if (!entry) {
    return EMPTY_SCOPE_NAVIGATION;
  }
  if (address.scope.kind === "overview") {
    return entry.overview;
  }
  return entry.group?.groupId === address.scope.groupId
    ? entry.group.navigation
    : EMPTY_SCOPE_NAVIGATION;
}

/**
 * Apply `update` to the navigation of one address. A written key moves to the
 * end of the recency order. Run keys and comparison keys past
 * `RETAINED_KEYS_PER_VIEW` are dropped oldest first, keeping the ones Runs and
 * Changes reopen. Writing a Group scope other than
 * the retained one replaces it, since a key holds at most one Group scope.
 */
export function updateScopeNavigation(
  navigation: WorkflowNavigation,
  address: WorkspaceAddress,
  update: (scope: ScopeNavigation) => ScopeNavigation
): WorkflowNavigation {
  const current = scopeNavigationAt(navigation, address);
  const next = update(current);
  if (next === current) {
    return navigation;
  }
  const keyId = workspaceKeyId(address.key);
  const entry = navigation.workspaces.get(keyId) ?? {
    overview: EMPTY_SCOPE_NAVIGATION,
    group: null,
  };
  const nextEntry: WorkspaceNavigation =
    address.scope.kind === "overview"
      ? { ...entry, overview: next }
      : {
          ...entry,
          group: { groupId: address.scope.groupId, navigation: next },
        };
  const workspaces = new Map(navigation.workspaces);
  workspaces.delete(keyId);
  workspaces.set(keyId, nextEntry);
  return {
    ...navigation,
    workspaces: evictOldKeys(workspaces, navigation.searches),
  };
}

/**
 * Drop the oldest run keys and comparison keys past the retained count. The
 * key each view's remembered search names is kept whatever its age.
 */
function evictOldKeys(
  workspaces: Map<string, WorkspaceNavigation>,
  searches: WorkflowNavigation["searches"]
): Map<string, WorkspaceNavigation> {
  const reopened = new Set(
    (["runs", "changes"] as const).flatMap((view) => {
      const search = searches[view];
      return search
        ? [workspaceKeyId(workspaceAddressFromSearch("", search).key)]
        : [];
    })
  );
  for (const prefix of ["run:", "comparison:"]) {
    const evictable = [...workspaces.keys()].filter(
      (keyId) => keyId.startsWith(prefix) && !reopened.has(keyId)
    );
    for (const keyId of evictable.slice(
      0,
      Math.max(0, evictable.length - RETAINED_KEYS_PER_VIEW)
    )) {
      workspaces.delete(keyId);
    }
  }
  return workspaces;
}

/**
 * Record the route search an address's view is showing, and whether that
 * address names a run.
 */
export function rememberRouteSearch(
  navigation: WorkflowNavigation,
  address: WorkspaceAddress
): WorkflowNavigation {
  const view = address.key.workspace;
  const search = workspaceRouteSearch(address);
  const remembered = navigation.searches[view];
  const hasNamedRun =
    navigation.hasNamedRun ||
    (address.key.workspace === "runs" && address.key.executionId !== null);
  if (
    remembered &&
    sameRouteSearch(remembered, search) &&
    hasNamedRun === navigation.hasNamedRun
  ) {
    return navigation;
  }
  return {
    ...navigation,
    searches: { ...navigation.searches, [view]: search },
    hasNamedRun,
  };
}

export function withChosenExecution(
  scope: ScopeNavigation,
  chosenExecution: ChosenRunExecution | null
): ScopeNavigation {
  return scope.chosenExecution?.nodeId === chosenExecution?.nodeId &&
    scope.chosenExecution?.logId === chosenExecution?.logId
    ? scope
    : { ...scope, chosenExecution };
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
 * The navigation with the selection emptied in every scope of the Draft key
 * and of each comparison key, which are the keys a Draft graph load replaces
 * the graph of. Run keys keep their selections, and every key keeps its
 * cameras, Reveal levels, remembered searches, and order.
 */
export function withoutDraftSelections(
  navigation: WorkflowNavigation
): WorkflowNavigation {
  const entries = [...navigation.workspaces];
  const cleared = mapOrSame(entries, (item): [string, WorkspaceNavigation] => {
    const [keyId, entry] = item;
    if (!keyIdPresentsDraft(keyId)) {
      return item;
    }
    const next = workspaceWithoutSelections(entry);
    return next === entry ? item : [keyId, next];
  });
  return cleared === entries
    ? navigation
    : { ...navigation, workspaces: new Map(cleared) };
}

/**
 * Clear the desktop and mobile cameras saved for the focused Group `groupId` in
 * every Draft and comparison key, as when that Group's layout direction
 * changed. Entering the Group then fits the camera to the steps it paints. Run
 * keys present the graph their run pinned, so their cameras stay.
 */
export function withoutGroupCameras(
  navigation: WorkflowNavigation,
  groupId: string
): WorkflowNavigation {
  const entries = [...navigation.workspaces];
  const cleared = mapOrSame(entries, (item): [string, WorkspaceNavigation] => {
    const [keyId, entry] = item;
    const group = entry.group;
    if (
      !keyIdPresentsDraft(keyId) ||
      group?.groupId !== groupId ||
      (group.navigation.desktop.camera === null &&
        group.navigation.mobile.camera === null)
    ) {
      return item;
    }
    const scope = group.navigation;
    return [
      keyId,
      {
        ...entry,
        group: {
          groupId,
          navigation: {
            ...scope,
            desktop: { ...scope.desktop, camera: null },
            mobile: { ...scope.mobile, camera: null },
          },
        },
      },
    ];
  });
  return cleared === entries
    ? navigation
    : { ...navigation, workspaces: new Map(cleared) };
}

/** The scope with nothing selected and no mobile sheet open. */
function withoutSelection(scope: ScopeNavigation): ScopeNavigation {
  return withoutMobileSheets(withSelection(scope, EMPTY_SELECTION));
}

function workspaceWithoutSelections(
  entry: WorkspaceNavigation
): WorkspaceNavigation {
  const overview = withoutSelection(entry.overview);
  const groupNavigation = entry.group
    ? withoutSelection(entry.group.navigation)
    : null;
  if (
    overview === entry.overview &&
    groupNavigation === (entry.group?.navigation ?? null)
  ) {
    return entry;
  }
  return {
    overview,
    group:
      entry.group && groupNavigation
        ? { groupId: entry.group.groupId, navigation: groupNavigation }
        : null,
  };
}

/**
 * Set the desktop Reveal level. An open level also becomes the level a newly
 * selected object opens at; closing keeps the level Reveal was closed from.
 * Closing also clears `inspectedOrigin`, which ends the jump it recorded.
 */
export function withDesktopRevealLevel(
  scope: ScopeNavigation,
  revealLevel: RevealLevel
): ScopeNavigation {
  const reopenLevel =
    revealLevel === "closed" ? scope.desktop.reopenLevel : revealLevel;
  const inspectedOrigin =
    revealLevel === "closed" ? null : scope.desktop.inspectedOrigin;
  return scope.desktop.revealLevel === revealLevel &&
    scope.desktop.reopenLevel === reopenLevel &&
    scope.desktop.inspectedOrigin === inspectedOrigin
    ? scope
    : {
        ...scope,
        desktop: {
          ...scope.desktop,
          revealLevel,
          reopenLevel,
          inspectedOrigin,
        },
      };
}

/**
 * Write a Draft selection and open Canvas Reveal for it on both form factors.
 * When the selection comes to hold one object it did not hold alone before,
 * desktop Reveal opens at the scope's `reopenLevel`, and the mobile sequence
 * starts over at that object's summary sheet. A different object than the one
 * inspected becomes the inspected object, and its inspector scroll and section
 * start over. A selection holding no single object closes the mobile sheets.
 */
export function withSelectionOpeningReveal(
  scope: ScopeNavigation,
  selection: CanvasSelection
): ScopeNavigation {
  const selected = selectedObject(selection);
  if (selected === null) {
    return withoutMobileSheets(withSelection(scope, selection));
  }
  if (sameObject(selectedObject(scope.selection), selected)) {
    return withSelection(scope, selection);
  }
  const withNext = withMobileSummaryOf(
    withSelection(scope, selection),
    selected
  );
  const opened = withDesktopRevealLevel(withNext, scope.desktop.reopenLevel);
  if (sameObject(scope.desktop.inspected, selected)) {
    return opened;
  }
  return {
    ...opened,
    desktop: {
      ...opened.desktop,
      inspected: selected,
      inspectorScroll: EMPTY_SCOPE_NAVIGATION.desktop.inspectorScroll,
      inspectorSection: null,
      inspectedOrigin: null,
    },
  };
}

/** Record how far the inspector at one open level is scrolled. */
export function withInspectorScroll(
  scope: ScopeNavigation,
  level: OpenRevealLevel,
  top: number
): ScopeNavigation {
  const stored = scope.desktop.inspectorScroll;
  return stored[level] === top
    ? scope
    : {
        ...scope,
        desktop: {
          ...scope.desktop,
          inspectorScroll: { ...stored, [level]: top },
        },
      };
}

export function withShowSuperseded(
  scope: ScopeNavigation,
  showSuperseded: boolean
): ScopeNavigation {
  return scope.showSuperseded === showSuperseded
    ? scope
    : { ...scope, showSuperseded };
}

/**
 * Record the Focus section a sectioned inspector shows. Another section starts
 * its Focus scroll at the top.
 */
export function withInspectorSection(
  scope: ScopeNavigation,
  section: string | null
): ScopeNavigation {
  return scope.desktop.inspectorSection === section
    ? scope
    : {
        ...scope,
        desktop: {
          ...scope.desktop,
          inspectorSection: section,
          inspectorScroll: { ...scope.desktop.inspectorScroll, focus: 0 },
        },
      };
}

/** Record where a jump to the inspected object started. */
export function withInspectedOrigin(
  scope: ScopeNavigation,
  inspectedOrigin: InspectedOrigin | null
): ScopeNavigation {
  return scope.desktop.inspectedOrigin === inspectedOrigin
    ? scope
    : { ...scope, desktop: { ...scope.desktop, inspectedOrigin } };
}

/**
 * The scope without an inspected object the graph no longer holds, and without
 * the scroll and section recorded for it, on either form factor.
 */
export function inspectionInGraph(
  scope: ScopeNavigation,
  graph: NavigationGraph
): ScopeNavigation {
  const withSheets = mobileSheetsInGraph(scope, graph);
  const { inspected } = withSheets.desktop;
  if (inspected === null || objectInGraph(inspected, graph)) {
    return withSheets;
  }
  return {
    ...withSheets,
    desktop: {
      ...withSheets.desktop,
      inspected: null,
      inspectorScroll: EMPTY_SCOPE_NAVIGATION.desktop.inspectorScroll,
      inspectorSection: null,
      inspectedOrigin: null,
    },
  };
}

export function withCamera(
  scope: ScopeNavigation,
  formFactor: FormFactor,
  camera: WorldCamera
): ScopeNavigation {
  const stored = scope[formFactor].camera;
  if (
    stored?.centerX === camera.centerX &&
    stored.centerY === camera.centerY &&
    stored.zoom === camera.zoom
  ) {
    return scope;
  }
  return formFactor === "desktop"
    ? { ...scope, desktop: { ...scope.desktop, camera } }
    : { ...scope, mobile: { ...scope.mobile, camera } };
}

/**
 * The part of a graph one scope shows and can select. The overview holds every
 * node outside a Group frame and every edge. A Group scope holds that Group's
 * members and the stored edges entering a member, which are the interior and
 * ingress edges a focused Group lets a person select. Continuation edges are
 * display only there.
 */
export function graphInScope(
  graph: NavigationGraph,
  scope: WorkspaceScope
): NavigationGraph {
  if (scope.kind === "group") {
    const nodes = graph.nodes.filter((node) => node.parentId === scope.groupId);
    const memberIds = new Set(nodes.map((node) => node.id));
    return {
      nodes,
      edges: graph.edges.filter((edge) => memberIds.has(edge.target)),
    };
  }
  const groupIds = new Set(
    graph.nodes.filter((node) => isGroupNode(node)).map((node) => node.id)
  );
  const nodes = graph.nodes.filter(
    (node) => node.parentId === undefined || !groupIds.has(node.parentId)
  );
  return nodes.length === graph.nodes.length ? graph : { ...graph, nodes };
}

/**
 * The scope that shows `nodeId`: the focused canvas of the Group frame holding
 * it, or the overview for every other node, including one the graph lacks.
 */
export function scopeOfNode(
  nodes: NavigationGraph["nodes"],
  nodeId: string
): WorkspaceScope {
  const node = nodes.find((item) => item.id === nodeId);
  const parent =
    node?.parentId === undefined
      ? undefined
      : nodes.find((item) => item.id === node.parentId);
  return parent && isGroupNode(parent)
    ? { kind: "group", groupId: parent.id }
    : OVERVIEW_SCOPE;
}

/** Node ids, kinds, and parents plus edge ids: the facts recovery reads. */
export function graphStructureKey(graph: NavigationGraph): string {
  const nodes = graph.nodes
    .map((node) => `${node.id}:${node.data.type}:${node.parentId ?? ""}`)
    .join(",");
  return `${nodes}|${graph.edges.map((edge) => edge.id).join(",")}`;
}

/** Whether the presented graph still holds the Group a scope is focused on. */
export function groupScopeExists(
  scope: WorkspaceScope,
  graph: NavigationGraph
): boolean {
  return (
    scope.kind === "overview" ||
    graph.nodes.some((node) => node.id === scope.groupId && isGroupNode(node))
  );
}

/**
 * The route search recovery settles on for what the editor could open.
 *
 * `groupMissing` drops the Group, `runMissing` returns Runs to the run list,
 * and a `missingComparisonBaseId` equal to the named base returns Changes to
 * the current publication. A
 * Changes route that names no base takes the base of the installed comparison,
 * so the route carries the exact comparison identity.
 */
export function recoveredRouteSearch(input: {
  search: WorkflowRouteSearch;
  groupMissing: boolean;
  runMissing: boolean;
  missingComparisonBaseId: string | null;
  installedComparisonBaseId: string | null | undefined;
}): WorkflowRouteSearch {
  const { search } = input;
  const next: WorkflowRouteSearch = { ...search };
  if (input.groupMissing) {
    delete next.group;
  }
  if (
    search.view === "runs" &&
    input.runMissing &&
    search.executionId !== undefined
  ) {
    delete next.executionId;
    delete next.group;
  }
  if (search.view === "changes") {
    if (
      search.compare !== undefined &&
      input.missingComparisonBaseId === search.compare
    ) {
      delete next.compare;
      delete next.group;
    } else if (
      search.compare === undefined &&
      typeof input.installedComparisonBaseId === "string"
    ) {
      next.compare = input.installedComparisonBaseId;
    }
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
