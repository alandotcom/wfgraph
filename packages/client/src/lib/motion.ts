const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function viewportAnimationDuration(): 0 | 300 {
  if (typeof window === "undefined") {
    return 0;
  }

  return window.matchMedia(REDUCED_MOTION_QUERY).matches ? 0 : 300;
}
