/**
 * The Canvas Reveal state the shell and the canvas camera both read, derived
 * from the active address's selection, presented graph, and stored desktop
 * presentation, and the writes a person's Reveal commands make. Levels create
 * no history entry.
 */

import { atom } from "jotai";
import { presentedGraphAtom } from "#src/lib/workflow-graph-presentation-store";
import {
  revealFollowsSelection,
  workspaceAddressId,
  type DesktopScopePresentation,
  type RevealLevel,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import {
  activeDesktopRevealLevelAtom,
  activeRevealPresentationAtom,
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  chooseDesktopRevealLevelAtom,
  setWorkspaceRevealLevelAtom,
} from "#src/lib/workflow-workspace-navigation";
import { revealSubject } from "./reveal-kinds";
import { effectiveRevealLevel, type RevealSubject } from "./reveal-subject";

export type CanvasRevealState = {
  address: WorkspaceAddress;
  addressId: string;
  subject: RevealSubject | null;
  /** The level on screen, after the subject's levels apply. */
  level: RevealLevel;
  presentation: DesktopScopePresentation;
};

export const canvasRevealAtom = atom((get): CanvasRevealState => {
  const address = get(activeWorkspaceAddressAtom);
  const graph = get(presentedGraphAtom);
  const subject = revealSubject({
    workspace: address.key.workspace,
    selection: get(activeSelectionAtom),
    nodes: graph?.nodes ?? [],
    edges: graph?.edges ?? [],
  });
  return {
    address,
    addressId: workspaceAddressId(address),
    subject,
    level: effectiveRevealLevel(get(activeDesktopRevealLevelAtom), subject),
    presentation: get(activeRevealPresentationAtom),
  };
});

/**
 * Show one level for the active address. A workspace that follows its selection
 * stores it on the scope. Any other workspace also keeps whether it is closed
 * as the preference cookie.
 */
export const showCanvasRevealLevelAtom = atom(
  null,
  (get, set, level: RevealLevel) => {
    const { address } = get(canvasRevealAtom);
    if (revealFollowsSelection(address.key.workspace)) {
      set(setWorkspaceRevealLevelAtom, { address, level });
      return;
    }
    set(chooseDesktopRevealLevelAtom, level);
  }
);

/** The level one Escape or Back leaves toward: Focus to Browse to Closed. */
export function unwoundLevel(level: RevealLevel): RevealLevel {
  return level === "focus" ? "browse" : "closed";
}

/**
 * Open Canvas Reveal for what the active address shows, or close it. It opens
 * at the level its scope reopens at, and does nothing with no subject.
 */
export const toggleCanvasRevealAtom = atom(null, (get, set) => {
  const { level, subject, presentation } = get(canvasRevealAtom);
  if (subject === null) {
    return;
  }
  set(
    showCanvasRevealLevelAtom,
    level === "closed" ? presentation.reopenLevel : "closed"
  );
});

/** Open a closed Canvas Reveal at the level its scope reopens at. */
export const reopenCanvasRevealAtom = atom(null, (get, set) => {
  const { level, subject, presentation } = get(canvasRevealAtom);
  if (subject !== null && level === "closed") {
    set(showCanvasRevealLevelAtom, presentation.reopenLevel);
  }
});
