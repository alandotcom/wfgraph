/**
 * The mobile Reveal sequence as navigation state: the sheets one scope keeps
 * open below `md`, and the pure reducers that open, close, scroll, and section
 * them. Each reducer answers its input unchanged when nothing needed to change.
 */

import { takeWhile } from "es-toolkit/array";
import {
  type CanvasSelection,
  type InspectedObject,
  type NavigationGraph,
  type ScopeNavigation,
  type ScopePresentation,
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
 * a run list, a run's overview, or a comparison's summary. `scroll` is its
 * body's scroll in pixels from the top. `section` is the section a sectioned
 * inspector shows, or the part of the address an address sheet shows, such as
 * a comparison's change list, with null for the first section.
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
export type MobileScopePresentation = ScopePresentation & {
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
export function topMobileSheet(scope: ScopeNavigation): MobileSheet | null {
  return scope.mobile.sheets.at(-1) ?? null;
}

function withMobileSheets(
  scope: ScopeNavigation,
  sheets: readonly MobileSheet[]
): ScopeNavigation {
  return { ...scope, mobile: { ...scope.mobile, sheets } };
}

/**
 * The sheets without each one showing an object the graph no longer holds.
 * Address sheets always stay, and so do the sheets above a removed sheet. When
 * the last sheet is removed, the object the new last sheet shows becomes the
 * selection, as Back does.
 */
export function mobileSheetsInGraph(
  scope: ScopeNavigation,
  graph: NavigationGraph
): ScopeNavigation {
  const { sheets } = scope.mobile;
  const kept = sheets.filter(
    (sheet) => sheet.inspected === null || objectInGraph(sheet.inspected, graph)
  );
  if (kept.length === sheets.length) {
    return scope;
  }
  const shown = kept.at(-1)?.inspected ?? null;
  const selected =
    shown !== null && !sameObject(shown, sheets.at(-1)?.inspected ?? null)
      ? withSelection(scope, selectionOf(shown))
      : scope;
  return withMobileSheets(selected, kept);
}

/** Close every mobile sheet. */
export function withoutMobileSheets(scope: ScopeNavigation): ScopeNavigation {
  return scope.mobile.sheets.length === 0 ? scope : withMobileSheets(scope, []);
}

/**
 * The mobile sequence started over at the summary sheet of `inspected`, unless
 * the only sheet already is that summary.
 */
export function withMobileSummaryOf(
  scope: ScopeNavigation,
  inspected: InspectedObject
): ScopeNavigation {
  const { sheets } = scope.mobile;
  if (
    sheets.length === 1 &&
    sheets[0].level === "summary" &&
    sameObject(sheets[0].inspected, inspected)
  ) {
    return scope;
  }
  return withMobileSheets(scope, [
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
  scope: ScopeNavigation,
  input: {
    level: MobileRevealLevel;
    inspected: InspectedObject;
    section?: string | null | undefined;
  }
): ScopeNavigation {
  const selected = withSelection(scope, selectionOf(input.inspected));
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
export function withoutTopMobileSheet(scope: ScopeNavigation): ScopeNavigation {
  const { sheets } = scope.mobile;
  if (sheets.length === 0) {
    return scope;
  }
  const remaining = sheets.slice(0, -1);
  const shown = remaining.at(-1)?.inspected ?? null;
  const selected = shown ? withSelection(scope, selectionOf(shown)) : scope;
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
  scope: ScopeNavigation
): ScopeNavigation {
  return scope.mobile.sheets.length === 0
    ? withMobileSheets(scope, [ADDRESS_SHEET])
    : scope;
}

/**
 * Show one section of the address itself over the open sequence, as a sheet at
 * `level`, such as a comparison's change list or its version history. With no
 * sheet open the address sheet opens beneath it, so Back reaches that sheet
 * before the canvas. When the last sheet already shows that section at that
 * level, nothing changes. The new sheet records the scope's mobile camera, which
 * Back restores, and the selection is left as it is.
 */
export function withMobileAddressSection(
  scope: ScopeNavigation,
  input: { level: MobileRevealLevel; section: string }
): ScopeNavigation {
  const { sheets } = scope.mobile;
  const top = sheets.at(-1);
  if (
    top !== undefined &&
    top.inspected === null &&
    top.level === input.level &&
    top.section === input.section
  ) {
    return scope;
  }
  return withMobileSheets(scope, [
    ...(top === undefined ? [ADDRESS_SHEET] : sheets),
    { ...ADDRESS_SHEET, level: input.level, section: input.section },
  ]);
}

/**
 * The sequence an address opens when the route reaches it from `source`, an
 * address of the same workspace. It changes only a scope with no sheet open
 * reached from a source with a sheet open. Another scope of the same key opens
 * the address sheets the source sequence starts with, each at its top, so Back
 * walks the same address sheets; any other address opens its address sheet.
 */
export function withMobileSequenceFrom(
  scope: ScopeNavigation,
  source: { sheets: readonly MobileSheet[]; sameKey: boolean }
): ScopeNavigation {
  if (scope.mobile.sheets.length > 0 || source.sheets.length === 0) {
    return scope;
  }
  const carried = source.sameKey
    ? takeWhile(source.sheets, (sheet) => sheet.inspected === null).map(
        (sheet) => ({ ...sheet, scroll: 0 })
      )
    : [];
  return withMobileSheets(
    scope,
    carried.length > 0 ? carried : [ADDRESS_SHEET]
  );
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
  scope: ScopeNavigation,
  inspected: InspectedObject
): ScopeNavigation {
  const { sheets } = scope.mobile;
  const top = sheets.at(-1);
  const inspector: MobileSheet = {
    level: "inspector",
    inspected,
    scroll: 0,
    section: null,
  };
  if (top === undefined) {
    return withMobileSheets(scope, [ADDRESS_SHEET, inspector]);
  }
  if (top.level !== "inspector" || top.inspected === null) {
    return withMobileSheets(scope, [...sheets, inspector]);
  }
  if (sameObject(top.inspected, inspected)) {
    return scope;
  }
  return withMobileSheets(scope, [...sheets.slice(0, -1), inspector]);
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
  scope: ScopeNavigation,
  inspected: InspectedObject,
  update: (sheet: MobileSheet) => MobileSheet
): ScopeNavigation {
  const { sheets } = scope.mobile;
  const top = sheets.at(-1);
  if (!top || !sameObject(top.inspected, inspected)) {
    return scope;
  }
  const next = update(top);
  return next === top
    ? scope
    : withMobileSheets(scope, [...sheets.slice(0, -1), next]);
}

/**
 * Record how far the body of the mobile sheet at `depth` (1 for the first
 * sheet) is scrolled. The write is dropped unless that sheet still shows
 * `inspected` at `level`, so a scroll read before Back, another sheet, or a new
 * selection never lands on a different sheet.
 */
export function withMobileSheetScroll(
  scope: ScopeNavigation,
  input: {
    depth: number;
    level: MobileRevealLevel;
    inspected: InspectedObject | null;
    top: number;
  }
): ScopeNavigation {
  const { sheets } = scope.mobile;
  const sheet = sheets.at(input.depth - 1);
  if (
    input.depth < 1 ||
    !sheet ||
    sheet.level !== input.level ||
    !sameObject(sheet.inspected, input.inspected) ||
    sheet.scroll === input.top
  ) {
    return scope;
  }
  return withMobileSheets(
    scope,
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
  scope: ScopeNavigation,
  inspected: InspectedObject,
  section: string | null
): ScopeNavigation {
  return withTopMobileSheet(scope, inspected, (sheet) =>
    sheet.section === section ? sheet : { ...sheet, section, scroll: 0 }
  );
}
