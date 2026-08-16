import { useSyncExternalStore } from "react";

const MOBILE_BREAKPOINT = 768;

function subscribe(onViewportChange: () => void) {
  const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
  query.addEventListener("change", onViewportChange);
  return () => query.removeEventListener("change", onViewportChange);
}

/**
 * The same question `useIsMobile` answers, sampled once instead of subscribed to.
 * For a callback that runs outside render and needs the width as it is at that
 * moment, such as an overlay's `onClose` deciding whether a rail has taken over.
 */
export function isMobileViewport() {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

/**
 * Whether the viewport is narrow enough to be treated as mobile.
 *
 * The viewport is a store that lives outside React, which is what
 * `useSyncExternalStore` is for: React reads the current width whenever it
 * needs to render, so there is no first render that reports the wrong answer
 * and no state to keep in step with the media query.
 */
export function useIsMobile() {
  return useSyncExternalStore(subscribe, isMobileViewport);
}
