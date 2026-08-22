import { useSyncExternalStore } from "react";

/**
 * Tailwind's `md` breakpoint, which `routes/globals.css` declares with
 * `@theme static` so it is a variable at runtime as well as a compile-time
 * variant. Everything that changes shape at that width reads this one value:
 * the shell's inset, border, radius and clip, the status strip's safe-area
 * offset, the canvas handles' touch targets, and this hook.
 *
 * The fallback is Tailwind's own default, for a document that has not loaded
 * the stylesheet.
 */
const DEFAULT_BREAKPOINT = "48rem";

let desktopQuery: MediaQueryList | undefined;

/**
 * One `MediaQueryList` for the whole app, because `useSyncExternalStore` asks
 * for the current value on every render and a `getComputedStyle` there would be
 * a style resolution per render. A breakpoint cannot change after the
 * stylesheet has loaded, and `matches` stays live on its own.
 */
function getDesktopQuery(): MediaQueryList {
  if (!desktopQuery) {
    const breakpoint = getComputedStyle(document.documentElement)
      .getPropertyValue("--breakpoint-md")
      .trim();
    desktopQuery = window.matchMedia(
      `(min-width: ${breakpoint || DEFAULT_BREAKPOINT})`
    );
  }
  return desktopQuery;
}

function subscribe(onViewportChange: () => void) {
  const query = getDesktopQuery();
  query.addEventListener("change", onViewportChange);
  return () => query.removeEventListener("change", onViewportChange);
}

/**
 * The same question `useIsMobile` answers, sampled once instead of subscribed to.
 * For a callback that runs outside render and needs the width as it is at that
 * moment, such as an overlay's `onClose` deciding whether a rail has taken over.
 */
export function isMobileViewport() {
  return !getDesktopQuery().matches;
}

/**
 * Whether the viewport is narrow enough to be treated as mobile.
 *
 * The viewport is a store that lives outside React, which is what
 * `useSyncExternalStore` is for: React reads the current width whenever it
 * needs to render, so there is no first render that reports the wrong answer
 * and no state to keep in step with the media query. Sampling and subscribing
 * go through the same query, so the two cannot disagree at a width that lands
 * between them.
 */
export function useIsMobile() {
  return useSyncExternalStore(subscribe, isMobileViewport);
}
