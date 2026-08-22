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
