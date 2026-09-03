import { atom } from "jotai";

/**
 * Editor chrome: which panel is open, how wide it is, which run is on screen.
 *
 * None of this belongs to the graph, so this module does not import
 * `workflow-graph-store`. Authorization is server state and each UI surface
 * reads it through its own bounded authorization query.
 *
 * Two of these preferences survive a reload, in cookies. Both are read once as
 * the atom's initial value and written from the atom's own setter, so there is
 * exactly one place each preference is persisted and no effect mirroring state
 * into storage after the fact.
 */

const SIDEBAR_WIDTH_COOKIE = "sidebar-width";
const SIDEBAR_COLLAPSED_COOKIE = "sidebar-collapsed";
const AGENT_PANEL_OPEN_COOKIE = "agent-panel-open";
const AGENT_PANEL_SIZE_COOKIE = "agent-panel-size";
const COOKIE_MAX_AGE_SECONDS = 31_536_000; // one year

const MIN_SIDEBAR_PERCENT = 20;
const MAX_SIDEBAR_PERCENT = 50;
const DEFAULT_SIDEBAR_PERCENT = 30;

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }
  return document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${name}=`))
    ?.split("=")[1];
}

function writeCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}`;
}

function readInitialSidebarPercent(): number {
  const value = Number.parseFloat(readCookie(SIDEBAR_WIDTH_COOKIE) ?? "");
  return value >= MIN_SIDEBAR_PERCENT && value <= MAX_SIDEBAR_PERCENT
    ? value
    : DEFAULT_SIDEBAR_PERCENT;
}

export type WorkflowWorkspaceView = "draft" | "runs" | "changes";

const workflowWorkspaceViewStateAtom = atom<WorkflowWorkspaceView>("draft");

/**
 * The editor-wide surface that owns the canvas and inspector.
 */
export const workflowWorkspaceViewAtom = atom(
  (get) => get(workflowWorkspaceViewStateAtom),
  (_get, set, view: WorkflowWorkspaceView) => {
    set(workflowWorkspaceViewStateAtom, view);
  }
);

export const showMinimapAtom = atom(false);

const sidebarCollapsedStateAtom = atom(
  readCookie(SIDEBAR_COLLAPSED_COOKIE) === "true"
);

/** Reading is plain; writing also persists, because that is the whole point. */
export const isSidebarCollapsedAtom = atom(
  (get) => get(sidebarCollapsedStateAtom),
  (get, set, next: boolean | ((previous: boolean) => boolean)) => {
    const value =
      typeof next === "function" ? next(get(sidebarCollapsedStateAtom)) : next;
    set(sidebarCollapsedStateAtom, value);
    writeCookie(SIDEBAR_COLLAPSED_COOKIE, String(value));
  }
);

const sidebarWidthStateAtom = atom(readInitialSidebarPercent());

export const sidebarWidthPercentAtom = atom(
  (get) => get(sidebarWidthStateAtom),
  (_get, set, value: number) => {
    set(sidebarWidthStateAtom, value);
    writeCookie(SIDEBAR_WIDTH_COOKIE, String(value));
  }
);

/**
 * The panel's rendered width as CSS, clamped.
 *
 * One home for the clamp, because two of them is a visible bug: the panel's
 * column reserves the space and the surface inside it slides through that
 * space, so a percentage in one and a clamped value in the other left a strip
 * of bare page between the canvas edge and the panel on any screen wide enough
 * for the percentage to beat the cap.
 *
 * Viewport units rather than `%`, because the two boxes have different
 * containing blocks and the collapsed one is zero wide. What the share is of is
 * the editor shell, which is the viewport less `--editor-inset` on each side:
 * `editorShellWidth` says the same thing to the resize drag, and the two have
 * to agree or the panel's edge lands an inset away from where the pointer
 * released it.
 *
 * The floor stops the panel becoming unusable on a small laptop; the cap stops
 * a bare percentage handing 576px of a 1920px screen to a column of form fields.
 */
export function sidebarWidthCss(percent: number): string {
  return `min(max(calc((100vw - 2 * var(--editor-inset, 0px)) * ${percent} / 100), 320px), 460px)`;
}

/**
 * The box the panel's percentage is a share of: the editor shell, which is the
 * viewport less `--editor-inset` on each side.
 *
 * Reconstructed from the same variable the CSS above reads rather than measured
 * off the shell element, so the two cannot answer with different widths. Called
 * per pointer move during a resize, which is a style read on the root element
 * and no layout; the window can change width mid-drag on a rotation or a
 * tiling window manager, and the drag it was replacing tracked that.
 *
 * The fallback is a full-width shell, which is what a document holding no
 * stylesheet has.
 */
export function editorShellWidth(): number {
  const inset = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(
      "--editor-inset"
    )
  );
  return window.innerWidth - (Number.isFinite(inset) ? inset : 0) * 2;
}

export const isExecutingAtom = atom(false);
export const isGeneratingAtom = atom(false);
/** Identifies the only agent turn allowed to change the open workflow. */
export const activeAgentTurnIdAtom = atom<symbol | null>(null);
export type AgentGraphUpdate = {
  workflowId: string;
  revision: number;
};
/** Identifies the latest accepted agent graph update for viewport fitting. */
export const agentGraphUpdateAtom = atom<AgentGraphUpdate | null>(null);

/**
 * The build agent's panel: whether it is open, and how big the user made it.
 *
 * It floats over the bottom-left of the canvas, so it reserves no canvas width.
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

const agentPanelSizeStateAtom = atom(readInitialAgentPanelSize());

export const agentPanelSizeAtom = atom(
  (get) => get(agentPanelSizeStateAtom),
  (_get, set, size: AgentPanelSize) => {
    const clamped = clampAgentPanelSize(size);
    set(agentPanelSizeStateAtom, clamped);
    writeCookie(AGENT_PANEL_SIZE_COOKIE, `${clamped.width}x${clamped.height}`);
  }
);

/** The run last opened in the Runs panel, whether or not that panel is up. */
const watchedExecutionIdAtom = atom<string | null>(null);

/**
 * The run the canvas is painting. It reports a run only while the Runs workspace
 * is active, so leaving it takes the chips, borders, and countdown off
 * the graph and stops both polls, without any caller having to remember to
 * clear it.
 */
export const selectedExecutionIdAtom = atom(
  (get) =>
    get(workflowWorkspaceViewAtom) === "runs"
      ? get(watchedExecutionIdAtom)
      : null,
  (_get, set, executionId: string | null) => {
    set(watchedExecutionIdAtom, executionId);
  }
);
