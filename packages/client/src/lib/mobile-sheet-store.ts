/**
 * The writes that open, close, and record the mobile Reveal sheets of a named
 * address, over the pure sheet updates in `mobile-sheet-navigation.ts`. Back
 * and Close leave the phone's camera where it is.
 */

import { atom } from "jotai";
import {
  withMobileAddressSection,
  withMobileAddressSheet,
  withMobileInspectorOverAddress,
  withMobileSequenceFrom,
  withMobileSheet,
  withMobileSheetScroll,
  withMobileSheetSection,
  withoutMobileSheets,
  withoutTopMobileSheet,
  type MobileRevealLevel,
} from "#src/lib/mobile-sheet-navigation";
import {
  revealFollowsSelection,
  workspaceAddressId,
  type InspectedObject,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import { selectedObject, withSelection } from "#src/lib/canvas-selection";
import {
  activeMobileSheetsAtom,
  activeWorkspaceAddressAtom,
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
 * Show one section of a named address as a sheet at `level` over its open
 * sheets, as `withMobileAddressSection` describes: in Changes the change list
 * as a summary sheet, or version history as an inspector sheet.
 */
export const openMobileAddressSectionAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      level: MobileRevealLevel;
      section: string;
    }
  ) => {
    set(updateAddressNavigationAtom, input.address, (scope) =>
      withMobileAddressSection(scope, input)
    );
  }
);

/**
 * Show the field differences of one changed object in a named comparison
 * address, selecting it alone, in one navigation write. When that address has
 * no sheet open and is another scope of the active comparison, the active
 * address's sheets are carried first, as applying its route would carry them,
 * so Back from a Group member reaches the change list the member was chosen
 * from. The inspector then opens as `withMobileInspectorOverAddress` describes.
 */
export const openMobileChangeAtom = atom(
  null,
  (
    get,
    set,
    input: { address: WorkspaceAddress; inspected: InspectedObject }
  ) => {
    const { address, inspected } = input;
    const active = get(activeWorkspaceAddressAtom);
    const sameComparison =
      workspaceAddressId({ ...active, scope: address.scope }) ===
      workspaceAddressId(address);
    const sheets = sameComparison ? get(activeMobileSheetsAtom) : [];
    set(updateAddressNavigationAtom, address, (scope) =>
      withMobileInspectorOverAddress(
        withSelection(
          withMobileSequenceFrom(scope, { sheets, sameKey: true }),
          inspected.kind === "node"
            ? { nodeIds: [inspected.id], edgeIds: [] }
            : { nodeIds: [], edgeIds: [inspected.id] }
        ),
        inspected
      )
    );
  }
);

/**
 * Open the mobile Reveal sequence of a named address, unless a sheet is
 * already open there: in Draft the summary sheet of the one object the address
 * selects, and in Runs and Changes the address sheet, such as a run list, a
 * run, or a comparison's summary. Answers whether the address shows the mobile
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
