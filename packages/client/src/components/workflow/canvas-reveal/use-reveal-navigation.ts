import { atom, useStore, type Atom } from "jotai";
import { useMemo } from "react";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
  workspaceAddressId,
  type InspectedObject,
  type InspectedOrigin,
  type OpenRevealLevel,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import {
  activeMobileSheetsAtom,
  activeRevealPresentationAtom,
  openInspectorSectionAtom,
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
};

const desktopShownSectionAtom = atom((get): ShownInspectorSection => {
  const { inspected, inspectorSection } = get(activeRevealPresentationAtom);
  return inspected ? { inspected, section: inspectorSection } : null;
});

const mobileShownSectionAtom = atom((get): ShownInspectorSection => {
  const top = get(activeMobileSheetsAtom).at(-1);
  return top ? { inspected: top.inspected, section: top.section } : null;
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
    if (isMobile) {
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
      };
    }
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
    };
  }, [isMobile, openSheet, store]);
}
