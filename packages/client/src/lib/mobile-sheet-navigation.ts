/**
 * The mobile Reveal sequence as navigation state: the sheets one address keeps
 * open below `md`, and the pure reducers that open, close, scroll, and section
 * them. Each reducer answers its input unchanged when nothing needed to change.
 */

import {
  type CanvasSelection,
  type InspectedObject,
  type NavigationGraph,
  type WorkspaceNavigation,
  type FormFactorPresentation,
} from "#src/lib/workflow-navigation-state";
import { sameObject, withSelection } from "#src/lib/canvas-selection";

/**
 * The named levels of the mobile Reveal sequence. `summary` is a sheet over the
 * bottom of the canvas, which stays visible above it, and `inspector` is the
 * full-screen editor that covers the canvas.
 */
export type MobileRevealLevel = "summary" | "inspector";

/**
 * One sheet of the mobile Reveal sequence. `inspected` is the object the sheet
 * shows, or null for an address sheet, which shows the address itself, such as
 * a run list or a run's overview. `scroll` is its body's scroll in pixels from
 * the top. `section` is the section a sectioned inspector shows, with null for
 * the first section.
 */
export type MobileSheet = {
  level: MobileRevealLevel;
  inspected: InspectedObject | null;
  scroll: number;
  section: string | null;
};

/**
 * The mobile presentation adds the sheets of the mobile Reveal sequence, the
 * first sheet opened first. The number of sheets is the sheet depth, and Back
 * removes the last sheet. No sheets means the canvas shows alone.
 */
export type MobilePresentation = FormFactorPresentation & {
  sheets: readonly MobileSheet[];
};

/** Whether the graph holds the node or edge `object` names. */
export function objectInGraph(
  object: InspectedObject,
  graph: NavigationGraph
): boolean {
  return object.kind === "node"
    ? graph.nodes.some((node) => node.id === object.id)
    : graph.edges.some((edge) => edge.id === object.id);
}

/**
 * A string naming what a sheet shows, for keys that change when another object
 * shows: `address` for an address sheet, and otherwise the object's kind and id.
 */
export function sheetObjectKey(inspected: InspectedObject | null): string {
  return inspected === null ? "address" : `${inspected.kind}:${inspected.id}`;
}

/**
 * Names one mobile sheet as shown: its address, depth, level on screen, and
 * object. The sheet's scroll, camera, and focus each change when it changes.
 */
export function mobileSheetKey(input: {
  addressId: string;
  depth: number;
  level: MobileRevealLevel;
  inspected: InspectedObject | null;
}): string {
  return `${input.addressId}|${input.depth}|${input.level}|${sheetObjectKey(input.inspected)}`;
}

/** The last mobile sheet, or null while the canvas shows alone. */
export function topMobileSheet(
  workspace: WorkspaceNavigation
): MobileSheet | null {
  return workspace.mobile.sheets.at(-1) ?? null;
}

function withMobileSheets(
  workspace: WorkspaceNavigation,
  sheets: readonly MobileSheet[]
): WorkspaceNavigation {
  return { ...workspace, mobile: { ...workspace.mobile, sheets } };
}

/**
 * The sheets without each one showing an object the graph no longer holds.
 * Address sheets always stay, and so do the sheets above a removed sheet. When
 * the last sheet is removed, the object the new last sheet shows becomes the
 * selection, as Back does.
 */
export function mobileSheetsInGraph(
  workspace: WorkspaceNavigation,
  graph: NavigationGraph
): WorkspaceNavigation {
  const { sheets } = workspace.mobile;
  const kept = sheets.filter(
    (sheet) => sheet.inspected === null || objectInGraph(sheet.inspected, graph)
  );
  if (kept.length === sheets.length) {
    return workspace;
  }
  const shown = kept.at(-1)?.inspected ?? null;
  const selected =
    shown !== null && !sameObject(shown, sheets.at(-1)?.inspected ?? null)
      ? withSelection(workspace, selectionOf(shown))
      : workspace;
  return withMobileSheets(selected, kept);
}

/** Close every mobile sheet. */
export function withoutMobileSheets(
  workspace: WorkspaceNavigation
): WorkspaceNavigation {
  return workspace.mobile.sheets.length === 0
    ? workspace
    : withMobileSheets(workspace, []);
}

/**
 * The mobile sequence started over at the summary sheet of `inspected`, unless
 * the only sheet already is that summary.
 */
export function withMobileSummaryOf(
  workspace: WorkspaceNavigation,
  inspected: InspectedObject
): WorkspaceNavigation {
  const { sheets } = workspace.mobile;
  if (
    sheets.length === 1 &&
    sheets[0].level === "summary" &&
    sameObject(sheets[0].inspected, inspected)
  ) {
    return workspace;
  }
  return withMobileSheets(workspace, [
    { level: "summary", inspected, scroll: 0, section: null },
  ]);
}

/**
 * Open one mobile sheet over the sheets already open, and select the object it
 * shows alone. When the last sheet already is that level for that object, only
 * a given `section` is recorded. An inspector opened with no sheet open gets
 * its object's summary beneath it, so Back reaches that summary before the
 * canvas.
 */
export function withMobileSheet(
  workspace: WorkspaceNavigation,
  input: {
    level: MobileRevealLevel;
    inspected: InspectedObject;
    section?: string | null | undefined;
  }
): WorkspaceNavigation {
  const selected = withSelection(workspace, selectionOf(input.inspected));
  const top = topMobileSheet(selected);
  if (
    top !== null &&
    top.level === input.level &&
    sameObject(top.inspected, input.inspected)
  ) {
    return input.section === undefined
      ? selected
      : withMobileSheetSection(selected, input.inspected, input.section);
  }
  const below: readonly MobileSheet[] =
    top === null && input.level === "inspector"
      ? [
          {
            level: "summary",
            inspected: input.inspected,
            scroll: 0,
            section: null,
          },
        ]
      : selected.mobile.sheets;
  return withMobileSheets(selected, [
    ...below,
    {
      level: input.level,
      inspected: input.inspected,
      scroll: 0,
      section: input.section ?? null,
    },
  ]);
}

/**
 * Remove the last mobile sheet, and select the object the sheet beneath it
 * shows. Removing the only sheet, or uncovering an address sheet, keeps the
 * selection, as leaving desktop Focus or closing desktop Reveal does.
 */
export function withoutTopMobileSheet(
  workspace: WorkspaceNavigation
): WorkspaceNavigation {
  const { sheets } = workspace.mobile;
  if (sheets.length === 0) {
    return workspace;
  }
  const remaining = sheets.slice(0, -1);
  const shown = remaining.at(-1)?.inspected ?? null;
  const selected = shown
    ? withSelection(workspace, selectionOf(shown))
    : workspace;
  return withMobileSheets(selected, remaining);
}

/**
 * The first sheet of an address, showing the address itself scrolled to its
 * top.
 */
const ADDRESS_SHEET: MobileSheet = {
  level: "summary",
  inspected: null,
  scroll: 0,
  section: null,
};

/**
 * Open the address sheet when no mobile sheet is open. An open sequence stays
 * as it is, so returning to an address keeps its depth. The selection is left
 * as it is.
 */
export function withMobileAddressSheet(
  workspace: WorkspaceNavigation
): WorkspaceNavigation {
  return workspace.mobile.sheets.length === 0
    ? withMobileSheets(workspace, [ADDRESS_SHEET])
    : workspace;
}

/**
 * The sequence an address opens when the route reaches it from another address
 * of the same workspace whose sheets were `sourceSheets`. It changes only an
 * address with no sheet open reached from one with a sheet open, which then
 * opens its address sheet.
 */
export function withMobileSequenceFrom(
  workspace: WorkspaceNavigation,
  sourceSheets: readonly MobileSheet[]
): WorkspaceNavigation {
  if (workspace.mobile.sheets.length > 0 || sourceSheets.length === 0) {
    return workspace;
  }
  return withMobileSheets(workspace, [ADDRESS_SHEET]);
}

/**
 * Show the inspector of `inspected` over the current address. With no sheet
 * open the sequence becomes the address sheet and the inspector. Over an
 * inspector of another object the object is swapped in place, starting its
 * scroll and section over. Over any other sheet the inspector is pushed. The
 * selection is left as it is, for a caller
 * that writes it in the same navigation update.
 */
export function withMobileInspectorOverAddress(
  workspace: WorkspaceNavigation,
  inspected: InspectedObject
): WorkspaceNavigation {
  const { sheets } = workspace.mobile;
  const top = sheets.at(-1);
  const inspector: MobileSheet = {
    level: "inspector",
    inspected,
    scroll: 0,
    section: null,
  };
  if (top === undefined) {
    return withMobileSheets(workspace, [ADDRESS_SHEET, inspector]);
  }
  if (top.level !== "inspector" || top.inspected === null) {
    return withMobileSheets(workspace, [...sheets, inspector]);
  }
  if (sameObject(top.inspected, inspected)) {
    return workspace;
  }
  return withMobileSheets(workspace, [...sheets.slice(0, -1), inspector]);
}

function selectionOf(object: InspectedObject): CanvasSelection {
  return object.kind === "node"
    ? { nodeIds: [object.id], edgeIds: [] }
    : { nodeIds: [], edgeIds: [object.id] };
}

/**
 * Apply `update` to the last mobile sheet while it shows `inspected`. A write
 * for an object the last sheet no longer shows is dropped, so a value read
 * before Back or a new selection never lands on the next sheet.
 */
function withTopMobileSheet(
  workspace: WorkspaceNavigation,
  inspected: InspectedObject,
  update: (sheet: MobileSheet) => MobileSheet
): WorkspaceNavigation {
  const { sheets } = workspace.mobile;
  const top = sheets.at(-1);
  if (!top || !sameObject(top.inspected, inspected)) {
    return workspace;
  }
  const next = update(top);
  return next === top
    ? workspace
    : withMobileSheets(workspace, [...sheets.slice(0, -1), next]);
}

/**
 * Record how far the body of the mobile sheet at `depth` (1 for the first
 * sheet) is scrolled. The write is dropped unless that sheet still shows
 * `inspected` at `level`, so a scroll read before Back, another sheet, or a new
 * selection never lands on a different sheet.
 */
export function withMobileSheetScroll(
  workspace: WorkspaceNavigation,
  input: {
    depth: number;
    level: MobileRevealLevel;
    inspected: InspectedObject | null;
    top: number;
  }
): WorkspaceNavigation {
  const { sheets } = workspace.mobile;
  const sheet = sheets.at(input.depth - 1);
  if (
    input.depth < 1 ||
    !sheet ||
    sheet.level !== input.level ||
    !sameObject(sheet.inspected, input.inspected) ||
    sheet.scroll === input.top
  ) {
    return workspace;
  }
  return withMobileSheets(
    workspace,
    sheets.map((item, index) =>
      index === input.depth - 1 ? { ...item, scroll: input.top } : item
    )
  );
}

/**
 * Record the section the last mobile sheet shows. Another section starts its
 * scroll at the top.
 */
export function withMobileSheetSection(
  workspace: WorkspaceNavigation,
  inspected: InspectedObject,
  section: string | null
): WorkspaceNavigation {
  return withTopMobileSheet(workspace, inspected, (sheet) =>
    sheet.section === section ? sheet : { ...sheet, section, scroll: 0 }
  );
}
