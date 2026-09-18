/**
 * When the canvas camera moves for Canvas Reveal and for the mobile Reveal
 * sheets. The camera moves only to show a subject Reveal or a sheet would
 * cover, and closing Reveal or removing a sheet never moves it.
 */

import type { MobileRevealLevel } from "#src/lib/mobile-sheet-navigation";
import type {
  InspectedObject,
  RevealLevel,
} from "#src/lib/workflow-navigation-state";
import { sameObject } from "#src/lib/canvas-selection";

/** What the camera last responded to. */
export type RevealCameraSlot = {
  addressId: string;
  subjectKey: string | null;
  level: RevealLevel;
  /** Canvas width occupied by Reveal and its inset. */
  occupiedWidth: number;
  /** The `revealResizeSequenceAtom` count: how many resizes have finished. */
  resizeSequence: number;
};

/**
 * A request to place nodes in Canvas Reveal's usable rectangle, for the address
 * it names, as the command palette and an issue link make. `sequence` tells two
 * requests for the same nodes apart.
 */
export type RevealPlacementRequest = {
  addressId: string;
  nodeIds: readonly string[];
  sequence: number;
};

/**
 * What to do when the Reveal the canvas shows changes. A placement request the
 * camera has not answered places its nodes once its address is shown, whichever
 * address was shown before. Otherwise a new address does nothing, because the
 * scope's saved camera restores it. A new subject, opening from Closed, an
 * increase in occupied width, and a finished resize of open Reveal place the
 * subject. Closing and any width-preserving level change keep the camera where
 * it is.
 */
export function revealCameraStep(input: {
  shown: RevealCameraSlot | null;
  next: RevealCameraSlot;
  request: RevealPlacementRequest | null;
  answeredSequence: number;
}): "keep" | "place-request" | "place" {
  const { shown, next, request } = input;
  if (
    request !== null &&
    request.sequence !== input.answeredSequence &&
    request.addressId === next.addressId
  ) {
    return "place-request";
  }
  if (shown === null || shown.addressId !== next.addressId) {
    return "keep";
  }
  if (next.level === "closed") {
    return "keep";
  }
  return shown.subjectKey !== next.subjectKey ||
    shown.level === "closed" ||
    next.occupiedWidth > shown.occupiedWidth ||
    shown.resizeSequence !== next.resizeSequence
    ? "place"
    : "keep";
}

/**
 * What the mobile camera last responded to: an address and the sheet on top of
 * its mobile Reveal sequence, with `depth` 1 for the first sheet. `sheet` is
 * null while no sheet shows.
 */
export type MobileSheetCameraSlot = {
  addressId: string;
  sheet: {
    depth: number;
    level: MobileRevealLevel;
    inspected: InspectedObject | null;
  } | null;
};

/**
 * Whether the mobile camera places the subject of the sheet that shows. A
 * summary sheet that opens in the address already shown places its subject
 * above the sheet: the first sheet, a sheet opened over another, or a sheet
 * showing another object at the same depth. Back, which removes a sheet, keeps
 * the camera where it is. A new address keeps the camera its scope restored.
 */
export function mobileSheetCameraStep(input: {
  shown: MobileSheetCameraSlot | null;
  next: MobileSheetCameraSlot;
}): "keep" | "place" {
  const { shown, next } = input;
  if (
    shown === null ||
    shown.addressId !== next.addressId ||
    next.sheet === null ||
    next.sheet.level !== "summary"
  ) {
    return "keep";
  }
  if (shown.sheet === null || next.sheet.depth > shown.sheet.depth) {
    return "place";
  }
  return next.sheet.depth === shown.sheet.depth &&
    !sameObject(next.sheet.inspected, shown.sheet.inspected)
    ? "place"
    : "keep";
}
