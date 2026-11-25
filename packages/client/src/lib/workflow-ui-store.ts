import { atom } from "jotai";
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
/** Identifies the latest complete graph replacement for viewport fitting. */
export const workflowGraphUpdateAtom = atom<WorkflowGraphUpdate | null>(null);

/**
 * Whether the build agent's conversation is open above its composer on the
 * canvas. Closed, the composer is one prompt line and the conversation is kept.
 */
export const agentConversationOpenAtom = atom(false);

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

/**
 * Focus the agent's composer and open its conversation, as the palette's
 * Agent command and "Describe it to the agent" do.
 */
export const focusAgentComposerAtom = atom(null, (get, set, text?: string) => {
  set(agentConversationOpenAtom, true);
  set(agentComposerFocusRequestAtom, {
    sequence: (get(agentComposerFocusRequestAtom)?.sequence ?? 0) + 1,
    text,
  });
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
