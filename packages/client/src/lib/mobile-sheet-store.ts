/**
 * The writes that open, close, and record the mobile Reveal sheets of a named
 * address, over the pure sheet updates in `mobile-sheet-navigation.ts`. Back
 * and Close leave the phone's camera where it is.
 */

import { atom } from "jotai";
import {
  withMobileAddressSheet,
  withMobileInspectorOverAddress,
  withMobileSheet,
  withMobileSheetScroll,
  withMobileSheetSection,
  withoutMobileSheets,
  withoutTopMobileSheet,
  type MobileRevealLevel,
} from "#src/lib/mobile-sheet-navigation";
import {
  revealFollowsSelection,
  type InspectedObject,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import { selectedObject } from "#src/lib/canvas-selection";
import {
  addressNavigation,
  updateAddressNavigationAtom,
} from "#src/lib/workflow-workspace-navigation";

/**
 * Open a mobile Reveal sheet for `inspected` in a named address, selecting that
 * object alone. `section` records the section a sectioned inspector shows.
 */
export const openMobileSheetAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      level: MobileRevealLevel;
      inspected: InspectedObject;
      section?: string | null | undefined;
    }
  ) => {
    set(updateAddressNavigationAtom, input.address, (scope) =>
      withMobileSheet(scope, input)
    );
  }
);

/**
 * Open the address sheet of a named address when no mobile sheet is open
 * there, keeping its selection.
 */
export const openMobileAddressSheetAtom = atom(
  null,
  (_get, set, address: WorkspaceAddress) => {
    set(updateAddressNavigationAtom, address, withMobileAddressSheet);
  }
);

/**
 * Show the inspector of `inspected` over the address sheet of a named address,
 * as run node evidence shows over its run. The selection is left as it is.
 */
export const openMobileInspectorOverAddressAtom = atom(
  null,
  (
    _get,
    set,
    input: { address: WorkspaceAddress; inspected: InspectedObject }
  ) => {
    set(updateAddressNavigationAtom, input.address, (scope) =>
      withMobileInspectorOverAddress(scope, input.inspected)
    );
  }
);

/**
 * Open the mobile Reveal sequence of a named address, unless a sheet is
 * already open there: in Draft the summary sheet of the one object the address
 * selects, and in Runs the address sheet of a run list or a run. Answers whether the address shows the mobile
 * Reveal sequence, which a Draft address whose selection holds no single object
 * does not.
 */
export const openMobileSelectionAtom = atom(
  null,
  (get, set, address: WorkspaceAddress): boolean => {
    if (!revealFollowsSelection(address.key.workspace)) {
      set(openMobileAddressSheetAtom, address);
      return true;
    }
    const scope = addressNavigation(get, address);
    const selected = selectedObject(scope.selection);
    if (selected === null) {
      return false;
    }
    if (scope.mobile.sheets.length === 0) {
      set(openMobileSheetAtom, {
        address,
        level: "summary",
        inspected: selected,
      });
    }
    return true;
  }
);

/**
 * Back on mobile: remove the last sheet of a named address and select what the
 * sheet beneath it shows.
 */
export const closeMobileSheetAtom = atom(
  null,
  (_get, set, address: WorkspaceAddress) => {
    set(updateAddressNavigationAtom, address, withoutTopMobileSheet);
  }
);

/**
 * Close every mobile sheet of a named address, keeping its selection.
 */
export const closeAllMobileSheetsAtom = atom(
  null,
  (_get, set, address: WorkspaceAddress) => {
    set(updateAddressNavigationAtom, address, withoutMobileSheets);
  }
);

/**
 * Record the scroll of the mobile sheet at `depth` in a named address. The
 * write is dropped unless that sheet still shows `inspected` at `level`.
 */
export const recordMobileSheetScrollAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      depth: number;
      level: MobileRevealLevel;
      inspected: InspectedObject | null;
      top: number;
    }
  ) => {
    set(updateAddressNavigationAtom, input.address, (scope) =>
      withMobileSheetScroll(scope, input)
    );
  }
);

/**
 * Record the section the last mobile sheet of a named address shows. The write
 * is dropped when that sheet no longer shows `inspected`.
 */
export const recordMobileSheetSectionAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      inspected: InspectedObject;
      section: string;
    }
  ) => {
    set(updateAddressNavigationAtom, input.address, (scope) =>
      withMobileSheetSection(scope, input.inspected, input.section)
    );
  }
);
