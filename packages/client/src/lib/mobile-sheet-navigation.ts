/**
 * The mobile Reveal sequence as navigation state: the sheets one scope keeps
 * open below `md`, and the pure reducers that open, close, scroll, and section
 * them. Each reducer answers its input unchanged when nothing needed to change.
 */

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
 * shows, `scroll` is its body's scroll in pixels from the top, and `section` is
 * the section a sectioned inspector shows, with null for its first section.
 */
export type MobileSheet = {
  level: MobileRevealLevel;
  inspected: InspectedObject;
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
 * The sheets above a removed sheet stay open. When the last sheet is removed,
 * the object the new last sheet shows becomes the selection, as Back does.
 */
export function mobileSheetsInGraph(
  scope: ScopeNavigation,
  graph: NavigationGraph
): ScopeNavigation {
  const { sheets } = scope.mobile;
  const kept = sheets.filter((sheet) => objectInGraph(sheet.inspected, graph));
  if (kept.length === sheets.length) {
    return scope;
  }
  const top = kept.at(-1);
  const selected =
    top && !sameObject(top.inspected, sheets.at(-1)?.inspected ?? null)
      ? withSelection(scope, selectionOf(top.inspected))
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
 * shows. Removing the only sheet keeps the selection, as closing desktop
 * Reveal does.
 */
export function withoutTopMobileSheet(scope: ScopeNavigation): ScopeNavigation {
  const { sheets } = scope.mobile;
  if (sheets.length === 0) {
    return scope;
  }
  const remaining = sheets.slice(0, -1);
  const beneath = remaining.at(-1);
  const selected = beneath
    ? withSelection(scope, selectionOf(beneath.inspected))
    : scope;
  return withMobileSheets(selected, remaining);
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
    inspected: InspectedObject;
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
