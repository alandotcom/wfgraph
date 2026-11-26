/**
 * What the Inspector and the mobile Reveal sheets show, derived from the
 * active address's selection, presented graph, and stored desktop
 * presentation; whether the Inspector card is open and how much of the canvas
 * it covers; and the writes that open and close the card and move Runs between
 * a run and a node's evidence. Levels create no history entry.
 */

import { atom, useAtomValue } from "jotai";
import { useIsMobile } from "#src/hooks/use-mobile";
import { presentedGraphAtom } from "#src/lib/workflow-graph-presentation-store";
import {
  mobileSheetKey,
  type MobileRevealLevel,
  type MobileSheet,
} from "#src/lib/mobile-sheet-navigation";
import {
  showsRunList,
  workspaceAddressId,
  type CanvasSelection,
  type DesktopPresentation,
  type RevealLevel,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import { sameObject, selectedObject } from "#src/lib/canvas-selection";
import {
  activeDesktopRevealLevelAtom,
  activeMobileSheetsAtom,
  activeRevealPresentationAtom,
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  recordInspectorDismissalAtom,
  setWorkspaceRevealLevelAtom,
} from "#src/lib/workflow-workspace-navigation";
import { revealSubject } from "./reveal-kinds";
import { effectiveRevealLevel, type RevealSubject } from "./reveal-subject";

export type CanvasRevealState = {
  address: WorkspaceAddress;
  addressId: string;
  subject: RevealSubject | null;
  /** The level shown, after the subject's levels apply. */
  level: RevealLevel;
  presentation: DesktopPresentation;
};

export const canvasRevealAtom = atom((get): CanvasRevealState => {
  const address = get(activeWorkspaceAddressAtom);
  const graph = get(presentedGraphAtom);
  const subject = revealSubject(
    {
      workspace: address.key.workspace,
      selection: get(activeSelectionAtom),
      nodes: graph?.nodes ?? [],
      edges: graph?.edges ?? [],
    },
    get
  );
  return {
    address,
    addressId: workspaceAddressId(address),
    subject,
    level: effectiveRevealLevel(get(activeDesktopRevealLevelAtom), subject),
    presentation: get(activeRevealPresentationAtom),
  };
});

/**
 * The subject the Inspector card shows at `md` and wider: the Reveal subject,
 * except in two cases where it has none. The run list is the floating
 * outline's, so a run list address shows no card. Several selected Draft steps
 * have no editor of their own; their commands are the context menu's.
 */
export const inspectorSubjectAtom = atom((get): RevealSubject | null => {
  const { address, subject } = get(canvasRevealAtom);
  const { key } = address;
  if (showsRunList(key)) {
    return null;
  }
  if (
    key.workspace === "draft" &&
    get(activeSelectionAtom).nodeIds.length > 1
  ) {
    return null;
  }
  return subject;
});

/**
 * Whether the Inspector card is open over the right of the canvas at `md` and
 * wider: while it has a subject, unless the person closed it on that subject.
 * A phone shows no card, whatever this answers.
 */
export const inspectorOpenAtom = atom((get): boolean => {
  const subject = get(inspectorSubjectAtom);
  return (
    subject !== null &&
    get(canvasRevealAtom).presentation.dismissedSubjectKey !== subject.key
  );
});

/** The Inspector card's width, in pixels. */
export const INSPECTOR_WIDTH_PX = 340;

/** The gap between the Inspector card and the canvas box's edges, in pixels. */
export const INSPECTOR_INSET_PX = 8;

/**
 * The pixels the Inspector card covers at the right edge of the canvas,
 * counting its inset, while it is open, and 0 while it is closed. The canvas
 * camera keeps placed steps clear of it and the agent's box ends short of it.
 */
export const inspectorCoveredWidthAtom = atom((get): number =>
  get(inspectorOpenAtom) ? INSPECTOR_WIDTH_PX + INSPECTOR_INSET_PX : 0
);

/**
 * Close the Inspector card and keep the selection, until the subject changes
 * or a press opens the card again through `openInspectorAtom`.
 */
export const dismissInspectorAtom = atom(null, (get, set) => {
  const { address } = get(canvasRevealAtom);
  const subject = get(inspectorSubjectAtom);
  if (subject !== null) {
    set(recordInspectorDismissalAtom, { address, subjectKey: subject.key });
  }
});

/**
 * What the mobile Reveal sequence shows for the active address: its last sheet
 * and the sheet beneath it, and the level on screen, which is the summary for
 * an object's full sheet when the subject offers none. Null with no sheet
 * open, and while the last sheet's object is no longer what the subject
 * inspects. Form factor is the reader's to check.
 */
export type MobileRevealState = {
  address: WorkspaceAddress;
  addressId: string;
  subject: RevealSubject;
  sheet: MobileSheet;
  beneath: MobileSheet | null;
  /** The number of open sheets, 1 for the first. */
  depth: number;
  level: MobileRevealLevel;
  /** The `mobileSheetKey` of the sheet on screen. */
  sheetKey: string;
};

export const mobileRevealAtom = atom((get): MobileRevealState | null => {
  const { address, addressId, subject } = get(canvasRevealAtom);
  const sheets = get(activeMobileSheetsAtom);
  const sheet = sheets.at(-1);
  if (
    !sheet ||
    subject === null ||
    !showsSheet({ subject, sheet, selection: get(activeSelectionAtom) })
  ) {
    return null;
  }
  const level: MobileRevealLevel =
    sheet.level === "full" &&
    (sheet.inspected === null || subject.offersFullSheet)
      ? "full"
      : "summary";
  return {
    address,
    addressId,
    subject,
    sheet,
    beneath: sheets.at(-2) ?? null,
    depth: sheets.length,
    level,
    sheetKey: mobileSheetKey({
      addressId,
      depth: sheets.length,
      level,
      inspected: sheet.inspected,
    }),
  };
});

/**
 * Whether `sheet` still shows. An address sheet always does. A sheet about an
 * object shows while the subject still inspects that object: in Runs the node
 * the run target names, which can be a node no canvas selection holds, and
 * elsewhere the object the selection holds alone.
 */
function showsSheet(input: {
  subject: RevealSubject;
  sheet: MobileSheet;
  selection: CanvasSelection;
}): boolean {
  const { inspected } = input.sheet;
  if (inspected === null) {
    return true;
  }
  if (input.subject.workspace === "runs") {
    const target = input.subject.runsTarget;
    return target?.kind === "node" && target.nodeId === inspected.id;
  }
  return sameObject(selectedObject(input.selection), inspected);
}

/**
 * The mobile Reveal state while the viewport is below `md`, and null at wider
 * viewports, where the Inspector shows the selection.
 */
export function useShownMobileReveal(): MobileRevealState | null {
  const isMobile = useIsMobile();
  const state = useAtomValue(mobileRevealAtom);
  return isMobile ? state : null;
}

/** Show one level of the Inspector for the active address. */
export const showCanvasRevealLevelAtom = atom(
  null,
  (get, set, level: RevealLevel) => {
    set(setWorkspaceRevealLevelAtom, {
      address: get(canvasRevealAtom).address,
      level,
    });
  }
);

/**
 * The level one Escape or Back leaves toward: Focus to Browse, and nothing
 * from Browse. Only Runs offers Focus.
 */
export function unwoundLevel(level: RevealLevel): RevealLevel | null {
  return level === "focus" ? "browse" : null;
}
