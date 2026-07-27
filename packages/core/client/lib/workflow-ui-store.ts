import { atom } from "jotai";
import type { ExecutionLogEntry } from "@/shared/workflow/types";

/**
 * Editor chrome: which panel is open, how wide it is, which run is on screen.
 *
 * None of this is persisted and none of it belongs to the graph, so this module
 * imports from neither `workflow-graph-store` nor `workflow-save-store`.
 */

export const propertiesPanelActiveTabAtom = atom<string>("properties");
export const showMinimapAtom = atom(false);
export const rightPanelWidthAtom = atom<string | null>(null);
export const isPanelAnimatingAtom = atom<boolean>(false);
export const hasSidebarBeenShownAtom = atom<boolean>(false);
export const isSidebarCollapsedAtom = atom<boolean>(false);
export const isTransitioningFromHomepageAtom = atom<boolean>(false);

export const showClearDialogAtom = atom(false);
export const showDeleteDialogAtom = atom(false);

export const isExecutingAtom = atom(false);
export const isGeneratingAtom = atom(false);

// Set to true to start a run, so a keyboard shortcut goes through the same
// path as the toolbar button rather than duplicating it.
export const triggerExecuteAtom = atom(false);

export const selectedExecutionIdAtom = atom<string | null>(null);

// nodeId -> log entry for the run currently being viewed.
export const executionLogsAtom = atom<Record<string, ExecutionLogEntry>>({});
