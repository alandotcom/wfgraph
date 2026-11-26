import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { WorkspaceView } from "#src/lib/workflow-navigation-state";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";

/**
 * Editor chrome: which view is active, whether the agent's conversation is
 * open, which run is on screen.
 *
 * None of this belongs to the graph, so this module does not import
 * `workflow-graph-store`. Authorization is server state and each UI surface
 * reads it through its own bounded authorization query.
 */

export type WorkflowWorkspaceView = WorkspaceView;

/**
 * The editor-wide surface that owns the canvas and inspector, as the route
 * names it.
 */
export const workflowWorkspaceViewAtom = atom(
  (get) => get(activeWorkspaceAddressAtom).key.workspace
);

export const showMinimapAtom = atom(false);

/**
 * The Rename dialog the workflow menu owns, which the command palette opens
 * too. `session` goes up on every open so the dialog remounts and re-reads the
 * current name; the dialog stays mounted while closing for its exit animation.
 */
export const renameWorkflowDialogAtom = atom({ open: false, session: 0 });

/** Open the Rename dialog on a fresh session. */
export const openRenameWorkflowDialogAtom = atom(null, (get, set) => {
  set(renameWorkflowDialogAtom, {
    open: true,
    session: get(renameWorkflowDialogAtom).session + 1,
  });
});

/**
 * Whether a run start this editor requested is still being created: from the
 * confirm until the started run's first status read, or until the server
 * starts nothing. Whether the open run is in progress is the projection's.
 */
export const runStartInFlightAtom = atom(false);
/** Identifies the only agent turn allowed to change the open workflow. */
export const activeAgentTurnIdAtom = atom<symbol | null>(null);
/** Whether an agent turn is running, which locks the canvas to its writes. */
export const isGeneratingAtom = atom(
  (get) => get(activeAgentTurnIdAtom) !== null
);
export type WorkflowGraphUpdate = {
  workflowId: string;
  revision: number;
};
/**
 * The latest change that moved the whole graph: an agent's edit, a draft saved
 * elsewhere, or Tidy layout. The canvas places its camera after each, the way
 * it places a workflow it opens.
 */
export const workflowGraphUpdateAtom = atom<WorkflowGraphUpdate | null>(null);

/**
 * Whether the build agent's conversation is open above its composer on the
 * canvas. Closed, the composer is one prompt line and the conversation is kept.
 */
export const agentConversationOpenAtom = atom(false);

/** The `localStorage` key holding whether the person hid the agent's box. */
const AGENT_HIDDEN_STORAGE_KEY = "wfgraph:agent-hidden";

/**
 * This browser's `localStorage`, or undefined where reading it throws, as a
 * policy that blocks site data makes it do.
 */
function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** A stored "true" or "false" as the boolean it names; anything else is unknown. */
function storedBoolean(value: string | null | undefined): boolean | undefined {
  return value === "true" ? true : value === "false" ? false : undefined;
}

/**
 * Where the agent's hidden preference is kept. Storage can be absent or refuse
 * a write (a private window, a full quota), so every access is wrapped: the
 * preference then holds for the life of the page and the editor renders as it
 * would with nothing stored. Another tab that hides or shows the agent updates
 * this one through the `storage` event.
 */
const agentHiddenStorage = {
  getItem: (key: string, initialValue: boolean): boolean => {
    try {
      return storedBoolean(browserStorage()?.getItem(key)) ?? initialValue;
    } catch {
      return initialValue;
    }
  },
  setItem: (key: string, value: boolean): void => {
    try {
      browserStorage()?.setItem(key, String(value));
    } catch {
      // The preference stays in memory for this page.
    }
  },
  removeItem: (key: string): void => {
    try {
      browserStorage()?.removeItem(key);
    } catch {
      // Nothing was stored that could be read back.
    }
  },
  subscribe: (
    key: string,
    callback: (value: boolean) => void,
    initialValue: boolean
  ) => {
    if (typeof window === "undefined") {
      return undefined;
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) {
        callback(storedBoolean(event.newValue) ?? initialValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  },
};

/**
 * Whether the person hid the build agent's box on the canvas, leaving only the
 * small Show agent control at the foot of the canvas. It is this viewer's
 * preference: it holds across workflows and survives a reload. A phone ignores
 * it, because its prompt line sits in the page's flow below the main view.
 */
export const agentHiddenAtom = atomWithStorage(
  AGENT_HIDDEN_STORAGE_KEY,
  false,
  agentHiddenStorage,
  { getOnInit: true }
);

/**
 * A request to put the cursor in the agent's composer, with text to place in
 * it when `text` is set. `sequence` tells two requests apart. The composer
 * answers it once and opens the conversation.
 */
export type AgentComposerFocusRequest = {
  sequence: number;
  text: string | undefined;
};

export const agentComposerFocusRequestAtom =
  atom<AgentComposerFocusRequest | null>(null);

/** The next request for the composer's cursor, carrying `text`. */
function nextFocusRequest(
  previous: AgentComposerFocusRequest | null,
  text: string | undefined
): AgentComposerFocusRequest {
  return { sequence: (previous?.sequence ?? 0) + 1, text };
}

/**
 * Focus the agent's composer and open its conversation, as the palette's
 * Agent command does. A hidden box shows again first.
 */
export const focusAgentComposerAtom = atom(null, (get, set, text?: string) => {
  set(agentHiddenAtom, false);
  set(agentConversationOpenAtom, true);
  set(
    agentComposerFocusRequestAtom,
    nextFocusRequest(get(agentComposerFocusRequestAtom), text)
  );
});

/**
 * Hide the agent's box, or show it again with the cursor in its prompt line,
 * as Cmd+J and the palette's Hide agent and Show agent do. Hiding collapses the
 * conversation and keeps it; a turn in progress keeps going.
 */
export const toggleAgentHiddenAtom = atom(null, (get, set) => {
  if (get(agentHiddenAtom)) {
    set(agentHiddenAtom, false);
    set(
      agentComposerFocusRequestAtom,
      nextFocusRequest(get(agentComposerFocusRequestAtom), undefined)
    );
    return;
  }
  set(agentConversationOpenAtom, false);
  set(agentHiddenAtom, true);
});

/**
 * The run the canvas is painting, as the route names it. It reports a run only
 * while the Runs workspace is active, so leaving it takes the chips, borders,
 * and countdown off the graph and stops both polls.
 */
export const selectedExecutionIdAtom = atom((get) => {
  const { key } = get(activeWorkspaceAddressAtom);
  return key.workspace === "runs" ? key.executionId : null;
});
