import { atom, useStore, type Atom } from "jotai";
import { useMemo } from "react";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useIsMobile } from "#src/hooks/use-mobile";
import { runEvidenceOriginAtom } from "#src/components/workflow/run-evidence-origin";
import {
  revealFollowsSelection,
  workspaceAddressId,
  type InspectedObject,
  type InspectedOrigin,
  type OpenRevealLevel,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import { selectedObject } from "#src/lib/canvas-selection";
import {
  activeDesktopRevealLevelAtom,
  activeMobileSheetsAtom,
  activeRevealPresentationAtom,
  activeSelectionAtom,
  inspectRunNodeAtom,
  openInspectorSectionAtom,
  openMobileAddressSheetAtom,
  openMobileInspectorOverAddressAtom,
  openMobileSheetAtom,
  openNodeRevealFromOriginAtom,
  openWorkspaceRevealAtom,
  recordInspectorSectionAtom,
  recordMobileSheetSectionAtom,
  setWorkspaceRevealLevelAtom,
  setWorkspaceSelectionAtom,
} from "#src/lib/workflow-workspace-navigation";
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
 * act on Canvas Reveal; below `md` they act on the mobile Reveal sequence and
 * the configuration sheet. Each action names the address it acts on.
 */
export type RevealNavigation = {
  /**
   * Select the node `nodeId` alone and open its inspector: Browse or the
   * summary sheet, or Focus or the full-screen inspector for `level` "focus".
   * With no `level`, desktop Reveal opens at the address's reopen level. An
   * `origin` records where a desktop jump started, which Back returns to. On
   * desktop a jump with no origin also asks the camera to place the node.
   */
  openNode: (input: {
    address: WorkspaceAddress;
    nodeId: string;
    level?: OpenRevealLevel | undefined;
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
  /** Open the inspector of `address` at Browse, or its sheet below `md`. */
  openInspector: (address: WorkspaceAddress) => void;
  /**
   * Show the inspector for a selection just written to `address`, where the
   * form factor does not show it by itself. Canvas Reveal follows the
   * selection, so on desktop this does nothing.
   */
  followSelection: (address: WorkspaceAddress) => void;
  /**
   * Show a node pressed on a canvas outside a run once the press has written
   * the selection. Desktop reopens a closed Canvas Reveal when the address
   * follows its selection and holds `nodeId` alone; below `md` the inspector
   * of the address opens.
   */
  showPressedNode: (input: {
    address: WorkspaceAddress;
    nodeId: string;
  }) => void;
  /**
   * Record which run node a run address shows. With `opensEvidence` the node's
   * evidence shows: Canvas Reveal at Focus, or the evidence inspector over the
   * run's address sheet. Without it the run's Browse shows, which below `md`
   * opens the run's address sheet.
   */
  inspectRunNode: (
    input: RunNodeInspection & { opensEvidence: boolean }
  ) => void;
  /**
   * Show a node pressed on a run's canvas: a step's evidence, or a Group card's
   * run summary, which has no evidence. On desktop a press that opens a closed
   * Reveal is recorded so Back closes it again, and opens it without writing
   * the Reveal preference.
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
    const recordRunCanvasPress = (
      input: { address: WorkspaceAddress; nodeId: string },
      closedReopenLevel: OpenRevealLevel | null
    ) =>
      store.set(runEvidenceOriginAtom, {
        addressId: workspaceAddressId(input.address),
        nodeId: input.nodeId,
        logId: null,
        closedReopenLevel,
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
        followSelection: openSheet,
        showPressedNode: ({ address }) => openSheet(address),
        inspectRunNode,
        pressRunCanvasNode: (input) => {
          recordRunCanvasPress(input, null);
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
      openNode: ({ address, nodeId, level, origin }) => {
        if (origin !== undefined) {
          store.set(openNodeRevealFromOriginAtom, { address, nodeId, origin });
          return;
        }
        store.set(setWorkspaceSelectionAtom, {
          address,
          selection: { nodeIds: [nodeId], edgeIds: [] },
        });
        store.set(openWorkspaceRevealAtom, { address, level });
        store.set(requestRevealPlacementAtom, {
          addressId: workspaceAddressId(address),
          nodeIds: [nodeId],
        });
      },
      openSection: (input) => store.set(openInspectorSectionAtom, input),
      recordSection: ({ address, nodeId, section }) =>
        store.set(recordInspectorSectionAtom, {
          address,
          inspectedId: nodeId,
          section,
        }),
      shownSectionAtom: desktopShownSectionAtom,
      openInspector: (address) =>
        store.set(setWorkspaceRevealLevelAtom, { address, level: "browse" }),
      followSelection: () => {},
      showPressedNode: ({ address, nodeId }) => {
        if (
          revealFollowsSelection(address.key.workspace) &&
          selectedObject(store.get(activeSelectionAtom))?.id === nodeId &&
          store.get(activeDesktopRevealLevelAtom) === "closed"
        ) {
          store.set(setWorkspaceRevealLevelAtom, {
            address,
            level: store.get(activeRevealPresentationAtom).reopenLevel,
          });
        }
      },
      inspectRunNode,
      pressRunCanvasNode: (input) => {
        const opensFromClosed =
          store.get(activeDesktopRevealLevelAtom) === "closed";
        const { reopenLevel } = store.get(activeRevealPresentationAtom);
        recordRunCanvasPress(input, opensFromClosed ? reopenLevel : null);
        inspectRunNode({
          address: input.address,
          nodeId: input.nodeId,
          executionLogId: null,
          selectsNode: true,
          opensEvidence: !input.isGroup,
        });
        if (opensFromClosed && input.isGroup) {
          // A Group frame's summary shows in Browse, which Runs limits the
          // reopen level to. The address level is written without the
          // preference, as a step's Focus is.
          store.set(setWorkspaceRevealLevelAtom, {
            address: input.address,
            level: reopenLevel,
          });
        }
      },
    };
  }, [isMobile, openSheet, store]);
}
