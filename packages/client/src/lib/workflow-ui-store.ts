import { atom } from "jotai";
import { isWorkflowOwnerAtom } from "#src/lib/workflow-save-store";

/**
 * Editor chrome: which panel is open, how wide it is, which run is on screen.
 *
 * None of this belongs to the graph, so this module does not import
 * `workflow-graph-store`. It does read `isWorkflowOwnerAtom` from
 * `workflow-save-store` so the Runs tab and the canvas overlay agree on
 * whether that owner-only tab is up; that module does not import this one.
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

export const propertiesPanelActiveTabAtom = atom<string>("properties");
export const showMinimapAtom = atom(false);
export const isTransitioningFromHomepageAtom = atom<boolean>(false);

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
 * The width the canvas has to give up to the sidebar, or null when it gives up
 * none. Nothing writes this: it is the panel's own state read from the other
 * side of the tree, rather than mirrored across by an effect that would need a
 * second effect on unmount just to undo the mirror.
 *
 * The mobile case is deliberately absent. Whether the viewport is narrow is the
 * canvas's own layout question, and it asks `useIsMobile` itself.
 */
/**
 * The panel's rendered width as CSS, clamped.
 *
 * One home for the clamp, because two of them is a visible bug: the canvas
 * reserves its space with `calc(100% - this)` while the panel sets `width` from
 * it, so a percentage here and a clamped value there left a strip of bare page
 * between the canvas edge and the panel on any screen wide enough for the
 * percentage to beat the cap.
 *
 * The floor stops the panel becoming unusable on a small laptop; the cap stops
 * a bare percentage handing 576px of a 1920px screen to a column of form fields.
 */
export function sidebarWidthCss(percent: number): string {
  return `min(max(${percent}%, 320px), 460px)`;
}

export const rightPanelWidthAtom = atom((get) =>
  get(isSidebarCollapsedAtom)
    ? null
    : sidebarWidthCss(get(sidebarWidthPercentAtom))
);

export const isExecutingAtom = atom(false);
export const isGeneratingAtom = atom(false);

/**
 * The build agent's panel: whether it is open, and how big the user made it.
 *
 * It floats over the bottom-left of the canvas rather than docking, so it
 * reserves no canvas width and `rightPanelWidthAtom` above stays the one
 * expression the canvas subtracts.
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

/**
 * The tab the panel actually shows: the stored one, unless it is the owner-only
 * Runs tab and the viewer is not the owner.
 */
export const activePropertiesTabAtom = atom((get) =>
  get(propertiesPanelActiveTabAtom) === "runs" && get(isWorkflowOwnerAtom)
    ? "runs"
    : "properties"
);

/** The run last opened in the Runs panel, whether or not that panel is up. */
const watchedExecutionIdAtom = atom<string | null>(null);

/**
 * The run the canvas is painting. It reports a run only while the Runs tab is
 * up, so leaving that tab takes the chips, the borders and the countdown off
 * the graph and stops both polls, without any caller having to remember to
 * clear it.
 */
export const selectedExecutionIdAtom = atom(
  (get) =>
    get(activePropertiesTabAtom) === "runs"
      ? get(watchedExecutionIdAtom)
      : null,
  (_get, set, executionId: string | null) => {
    set(watchedExecutionIdAtom, executionId);
  }
);
