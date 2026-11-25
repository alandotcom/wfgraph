import { atom, useStore, type Atom } from "jotai";
import { useMemo } from "react";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useIsMobile } from "#src/hooks/use-mobile";
import { runEvidenceOriginAtom } from "#src/components/workflow/run-evidence-origin";
import {
  workspaceAddressId,
  type InspectedObject,
  type InspectedOrigin,
  type RevealLevel,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import {
  openMobileAddressSheetAtom,
  openMobileInspectorOverAddressAtom,
  openMobileSheetAtom,
  recordMobileSheetSectionAtom,
} from "#src/lib/mobile-sheet-store";
import {
  activeMobileSheetsAtom,
  activeRevealPresentationAtom,
  inspectRunNodeAtom,
  openInspectorSectionAtom,
  openNodeRevealFromOriginAtom,
  recordInspectorSectionAtom,
  setWorkspaceSelectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import { showDetailsTabAtom } from "#src/components/workflow/columns/editor-columns-store";
import { requestRevealPlacementAtom } from "./reveal-requests";

/** The object an inspector shows and the section it shows for that object. */
export type ShownInspectorSection = {
  inspected: InspectedObject;
  section: string | null;
} | null;

/** Which run node a run address shows, as `inspectRunNodeAtom` records it. */
type RunNodeInspection = {
  address: WorkspaceAddress;
  nodeId: string;
  executionLogId: string | null;
  selectsNode: boolean;
};

/**
 * The inspector actions of the viewport's form factor. At `md` and wider they
 * act on the details column, which is always present, so most of them only
 * write a selection there; below `md` they act on the mobile Reveal
 * sequence and the configuration sheet. Each action names the address it acts
 * on.
 */
export type RevealNavigation = {
  /**
   * Select the node `nodeId` alone and show its inspector: the details
   * column's Details tab, brought back when collapsed, or on a phone the summary sheet, or the full-screen inspector for `level`
   * "focus". An `origin` records where a desktop jump started, which Back
   * returns to. On desktop a jump with no origin also asks the camera to show
   * the node, which moves it only when the node is not fully in view.
   */
  openNode: (input: {
    address: WorkspaceAddress;
    nodeId: string;
    level?: RevealLevel | undefined;
    origin?: InspectedOrigin | undefined;
  }) => void;
  /** Open the sectioned inspector of `nodeId` at `section`. */
  openSection: (input: {
    address: WorkspaceAddress;
    nodeId: string;
    section: string;
    origin?: InspectedOrigin | undefined;
  }) => void;
  /** Record the section the inspector of `nodeId` shows. */
  recordSection: (input: {
    address: WorkspaceAddress;
    nodeId: string;
    section: string;
  }) => void;
  /** The object the active inspector shows and its section. */
  shownSectionAtom: Atom<ShownInspectorSection>;
  /**
   * Show the inspector of `address`: its sheet below `md`. The details column
   * is always present, so on desktop this does nothing.
   */
  openInspector: (address: WorkspaceAddress) => void;
  /**
   * Show the inspector of the Runs workspace just switched to at `address`.
   * Below `md` the sheets are not remembered across a switch, so every switch
   * opens the inspector. The details column needs nothing.
   */
  showSwitchedWorkspace: (input: {
    address: WorkspaceAddress;
    firstVisit: boolean;
  }) => void;
  /**
   * Show the inspector for a selection just written to `address`, where the
   * form factor does not show it by itself. The details column follows the
   * selection, so on desktop this does nothing.
   */
  followSelection: (address: WorkspaceAddress) => void;
  /**
   * Show a node pressed on a canvas outside a run, or chosen elsewhere, once
   * the selection is written. Below `md` the address opens its inspector. The
   * details column already shows the selection.
   */
  showPressedNode: (input: {
    address: WorkspaceAddress;
    nodeId: string;
  }) => void;
  /**
   * Record which run node a run address shows. With `opensEvidence` the node's
   * evidence shows: the details column at Focus, or the evidence inspector
   * over the run's address sheet. Without it the run's Browse shows, which
   * below `md` opens the run's address sheet.
   */
  inspectRunNode: (
    input: RunNodeInspection & { opensEvidence: boolean }
  ) => void;
  /**
   * Show a node pressed on a run's canvas: a step's evidence, or a Group card's
   * run summary, which has no evidence. The press is recorded so Back returns
   * focus to the node.
   */
  pressRunCanvasNode: (input: {
    address: WorkspaceAddress;
    nodeId: string;
    isGroup: boolean;
  }) => void;
};

const desktopShownSectionAtom = atom((get): ShownInspectorSection => {
  const { inspected, inspectorSection } = get(activeRevealPresentationAtom);
  return inspected ? { inspected, section: inspectorSection } : null;
});

const mobileShownSectionAtom = atom((get): ShownInspectorSection => {
  const top = get(activeMobileSheetsAtom).at(-1);
  return top?.inspected
    ? { inspected: top.inspected, section: top.section }
    : null;
});

/**
 * The Reveal actions for the current form factor, chosen once here so no
 * surface that opens an inspector tests the viewport width itself.
 */
export function useRevealNavigation(): RevealNavigation {
  const isMobile = useIsMobile();
  const store = useStore();
  const { openSheet } = useConfigurationSheet();

  return useMemo((): RevealNavigation => {
    const node = (id: string): InspectedObject => ({ kind: "node", id });
    const recordRunCanvasPress = (input: {
      address: WorkspaceAddress;
      nodeId: string;
    }) =>
      store.set(runEvidenceOriginAtom, {
        addressId: workspaceAddressId(input.address),
        nodeId: input.nodeId,
        logId: null,
      });
    if (isMobile) {
      const inspectRunNode: RevealNavigation["inspectRunNode"] = (input) => {
        store.set(inspectRunNodeAtom, { ...input, opensFocus: false });
        if (input.opensEvidence) {
          store.set(openMobileInspectorOverAddressAtom, {
            address: input.address,
            inspected: node(input.nodeId),
          });
        } else {
          store.set(openMobileAddressSheetAtom, input.address);
        }
      };
      return {
        openNode: ({ address, nodeId, level }) =>
          store.set(openMobileSheetAtom, {
            address,
            level: level === "focus" ? "inspector" : "summary",
            inspected: node(nodeId),
          }),
        openSection: ({ address, nodeId, section }) =>
          store.set(openMobileSheetAtom, {
            address,
            level: "inspector",
            inspected: node(nodeId),
            section,
          }),
        recordSection: ({ address, nodeId, section }) =>
          store.set(recordMobileSheetSectionAtom, {
            address,
            inspected: node(nodeId),
            section,
          }),
        shownSectionAtom: mobileShownSectionAtom,
        openInspector: openSheet,
        showSwitchedWorkspace: ({ address }) => openSheet(address),
        followSelection: openSheet,
        showPressedNode: ({ address }) => openSheet(address),
        inspectRunNode,
        pressRunCanvasNode: (input) => {
          recordRunCanvasPress(input);
          inspectRunNode({
            address: input.address,
            nodeId: input.nodeId,
            executionLogId: null,
            selectsNode: true,
            opensEvidence: !input.isGroup,
          });
        },
      };
    }
    const inspectRunNode: RevealNavigation["inspectRunNode"] = ({
      opensEvidence,
      ...input
    }) =>
      store.set(inspectRunNodeAtom, { ...input, opensFocus: opensEvidence });
    return {
      openNode: ({ address, nodeId, origin }) => {
        store.set(showDetailsTabAtom);
        if (origin !== undefined) {
          store.set(openNodeRevealFromOriginAtom, { address, nodeId, origin });
          return;
        }
        store.set(setWorkspaceSelectionAtom, {
          address,
          selection: { nodeIds: [nodeId], edgeIds: [] },
        });
        store.set(requestRevealPlacementAtom, {
          addressId: workspaceAddressId(address),
          nodeIds: [nodeId],
        });
      },
      openSection: (input) => {
        store.set(showDetailsTabAtom);
        store.set(openInspectorSectionAtom, input);
      },
      recordSection: ({ address, nodeId, section }) =>
        store.set(recordInspectorSectionAtom, {
          address,
          inspectedId: nodeId,
          section,
        }),
      shownSectionAtom: desktopShownSectionAtom,
      openInspector: () => {},
      showSwitchedWorkspace: () => {},
      followSelection: () => {},
      showPressedNode: () => {},
      inspectRunNode,
      pressRunCanvasNode: (input) => {
        recordRunCanvasPress(input);
        inspectRunNode({
          address: input.address,
          nodeId: input.nodeId,
          executionLogId: null,
          selectsNode: true,
          opensEvidence: !input.isGroup,
        });
      },
    };
  }, [isMobile, openSheet, store]);
}
