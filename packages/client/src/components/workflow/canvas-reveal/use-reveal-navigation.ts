import { useStore } from "jotai";
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
  openMobileFullSheetOverAddressAtom,
  openMobileSheetAtom,
} from "#src/lib/mobile-sheet-store";
import {
  inspectRunNodeAtom,
  openInspectorAtom,
  openNodeRevealFromOriginAtom,
  setWorkspaceSelectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import {
  requestRevealPlacementAtom,
  revealFieldRequestAtom,
} from "./reveal-requests";

/** Which run node a run address shows, as `inspectRunNodeAtom` records it. */
type RunNodeInspection = {
  address: WorkspaceAddress;
  nodeId: string;
  executionLogId: string | null;
  selectsNode: boolean;
};

/**
 * The inspector actions of the viewport's form factor. At `md` and wider they
 * act on the Inspector, which opens by itself when the selection gives it a
 * subject, so most of them only write a selection. Each one a press runs also
 * opens the card again after its X or Escape closed it on the same subject:
 * `openNode`, `openSection`, `openInspector`, `showPressedNode`,
 * `inspectRunNode` and `pressRunCanvasNode`. Below `md` they act on the mobile
 * Reveal sequence and the configuration sheet. Each action names the address
 * it acts on.
 */
export type RevealNavigation = {
  /**
   * Select the node `nodeId` alone and show its inspector: the Inspector
   * card, opened again if its Close had closed it, or on a phone the summary
   * sheet, or the full-screen inspector for `level` "focus". An `origin` records where a desktop jump started, which Back
   * returns to. On desktop a jump with no origin also asks the camera to show
   * the node, which moves it only when the node is not fully in view.
   */
  openNode: (input: {
    address: WorkspaceAddress;
    nodeId: string;
    level?: RevealLevel | undefined;
    origin?: InspectedOrigin | undefined;
  }) => void;
  /**
   * Open the editor of `nodeId` with focus on the element `targetId` names,
   * such as the first control of one of the Start's rules. On desktop the
   * node opens as `openNode` opens it; on a phone the full-screen inspector
   * opens.
   */
  openSection: (input: {
    address: WorkspaceAddress;
    nodeId: string;
    targetId: string;
    origin?: InspectedOrigin | undefined;
  }) => void;
  /**
   * Show the inspector of `address`: its sheet below `md`, or the Inspector
   * card for the subject the selection already gives it.
   */
  openInspector: (address: WorkspaceAddress) => void;
  /**
   * Show the inspector of the Runs workspace just switched to at `address`.
   * Below `md` the sheets are not remembered across a switch, so every switch
   * opens the inspector. The Inspector needs nothing.
   */
  showSwitchedWorkspace: (input: {
    address: WorkspaceAddress;
    firstVisit: boolean;
  }) => void;
  /**
   * Show the inspector for a selection just written to `address`, where the
   * form factor does not show it by itself. The Inspector follows the
   * selection, so on desktop this does nothing.
   */
  followSelection: (address: WorkspaceAddress) => void;
  /**
   * Show a node pressed on a canvas outside a run, or chosen elsewhere, once
   * the selection is written. Below `md` the address opens its inspector. The
   * Inspector already shows the selection, and opens again if it was closed.
   */
  showPressedNode: (input: {
    address: WorkspaceAddress;
    nodeId: string;
  }) => void;
  /**
   * Record which run node a run address shows. With `opensEvidence` the node's
   * evidence shows: the Inspector at Focus, or the evidence inspector
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
          store.set(openMobileFullSheetOverAddressAtom, {
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
            level: level === "focus" ? "full" : "summary",
            inspected: node(nodeId),
          }),
        openSection: ({ address, nodeId, targetId }) => {
          store.set(openMobileSheetAtom, {
            address,
            level: "full",
            inspected: node(nodeId),
          });
          store.set(revealFieldRequestAtom, { nodeId, targetId });
        },
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
    const openInspector = (address: WorkspaceAddress) =>
      store.set(openInspectorAtom, address);
    const inspectRunNode: RevealNavigation["inspectRunNode"] = ({
      opensEvidence,
      ...input
    }) => {
      openInspector(input.address);
      store.set(inspectRunNodeAtom, { ...input, opensFocus: opensEvidence });
    };
    const openNode: RevealNavigation["openNode"] = ({
      address,
      nodeId,
      origin,
    }) => {
      openInspector(address);
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
    };
    return {
      openNode,
      openSection: ({ address, nodeId, targetId, origin }) => {
        openNode({ address, nodeId, origin });
        store.set(revealFieldRequestAtom, { nodeId, targetId });
      },
      openInspector,
      showSwitchedWorkspace: () => {},
      followSelection: () => {},
      showPressedNode: ({ address }) => openInspector(address),
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
