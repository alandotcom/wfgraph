import { atom } from "jotai";
import type { WorkspaceView } from "#src/lib/workflow-navigation-state";
import { readCookie, writeCookie } from "#src/lib/preference-cookies";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";

/**
 * Editor chrome: which view is active, the agent panel, which run is on screen.
 *
 * None of this belongs to the graph, so this module does not import
 * `workflow-graph-store`. Authorization is server state and each UI surface
 * reads it through its own bounded authorization query.
 *
 * The agent panel survives a reload, in cookies. Each is read once as the
 * atom's initial value and written from the atom's own setter, so there is
 * exactly one place each preference is persisted and no effect mirroring state
 * into storage after the fact.
 */

const AGENT_PANEL_OPEN_COOKIE = "agent-panel-open";
const AGENT_PANEL_SIZE_COOKIE = "agent-panel-size";

export type WorkflowWorkspaceView = WorkspaceView;

/**
 * The editor-wide surface that owns the canvas and inspector, as the route
 * names it.
 */
export const workflowWorkspaceViewAtom = atom(
  (get) => get(activeWorkspaceAddressAtom).key.workspace
);

export const showMinimapAtom = atom(false);

export const isExecutingAtom = atom(false);
export const isGeneratingAtom = atom(false);
/** Identifies the only agent turn allowed to change the open workflow. */
export const activeAgentTurnIdAtom = atom<symbol | null>(null);
export type WorkflowGraphUpdate = {
  workflowId: string;
  revision: number;
};
/** Identifies the latest complete graph replacement for viewport fitting. */
export const workflowGraphUpdateAtom = atom<WorkflowGraphUpdate | null>(null);

/**
 * The build agent's panel: whether it is open, whether it covers the editor,
 * and how big the user made it while docked.
 *
 * Docked it floats over the bottom-left of the canvas, so it reserves no canvas
 * width. Expanded it covers the editor and the size below stops applying.
 */
const AGENT_PANEL_MIN = { width: 320, height: 280 } as const;
const AGENT_PANEL_MAX = { width: 720, height: 900 } as const;
const AGENT_PANEL_DEFAULT = { width: 400, height: 520 } as const;

export type AgentPanelSize = { width: number; height: number };

function clampAgentPanelSize(size: AgentPanelSize): AgentPanelSize {
  return {
    width: Math.min(
      Math.max(size.width, AGENT_PANEL_MIN.width),
      AGENT_PANEL_MAX.width
    ),
    height: Math.min(
      Math.max(size.height, AGENT_PANEL_MIN.height),
      AGENT_PANEL_MAX.height
    ),
  };
}

function readInitialAgentPanelSize(): AgentPanelSize {
  const [width, height] = (readCookie(AGENT_PANEL_SIZE_COOKIE) ?? "")
    .split("x")
    .map((part) => Number.parseFloat(part));

  return Number.isFinite(width) && Number.isFinite(height)
    ? clampAgentPanelSize({ width, height })
    : AGENT_PANEL_DEFAULT;
}

const agentPanelOpenStateAtom = atom(
  readCookie(AGENT_PANEL_OPEN_COOKIE) === "true"
);

export const isAgentPanelOpenAtom = atom(
  (get) => get(agentPanelOpenStateAtom),
  (get, set, next: boolean | ((previous: boolean) => boolean)) => {
    const value =
      typeof next === "function" ? next(get(agentPanelOpenStateAtom)) : next;
    set(agentPanelOpenStateAtom, value);
    writeCookie(AGENT_PANEL_OPEN_COOKIE, String(value));
  }
);

/**
 * Whether the panel covers the editor rather than sitting on the canvas.
 *
 * Deliberately not persisted, and cleared when the panel closes: covering the
 * editor is something a reader asks for to read one long turn, so the next time
 * they open the agent it should be back on the canvas with the graph in view.
 */
export const isAgentPanelExpandedAtom = atom(false);

const agentPanelSizeStateAtom = atom(readInitialAgentPanelSize());

export const agentPanelSizeAtom = atom(
  (get) => get(agentPanelSizeStateAtom),
  (_get, set, size: AgentPanelSize) => {
    const clamped = clampAgentPanelSize(size);
    set(agentPanelSizeStateAtom, clamped);
    writeCookie(AGENT_PANEL_SIZE_COOKIE, `${clamped.width}x${clamped.height}`);
  }
);

/**
 * The run the canvas is painting, as the route names it. It reports a run only
 * while the Runs workspace is active, so leaving it takes the chips, borders,
 * and countdown off the graph and stops both polls.
 */
export const selectedExecutionIdAtom = atom((get) => {
  const { key } = get(activeWorkspaceAddressAtom);
  return key.workspace === "runs" ? key.executionId : null;
});
