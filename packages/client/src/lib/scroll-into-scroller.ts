/**
 * Scrolls one container to show an element inside it, by setting that
 * container's `scrollTop` alone. `scrollIntoView` also scrolls every
 * scrollable ancestor up to the document, which in the editor moves the
 * toolbar and the canvas.
 */

/**
 * Scroll `scroller` the least distance that shows `element` whole. An element
 * already in view stays where it is. One taller than the scroller lines its
 * top up with the scroller's top.
 */
export function scrollIntoScroller(
  scroller: HTMLElement,
  element: HTMLElement
): void {
  const box = scroller.getBoundingClientRect();
  const shown = element.getBoundingClientRect();
  if (shown.top < box.top || shown.height > box.height) {
    scroller.scrollTop -= box.top - shown.top;
  } else if (shown.bottom > box.bottom) {
    scroller.scrollTop += shown.bottom - box.bottom;
  }
}

/**
 * The nearest ancestor of `element` that scrolls vertically, searched up to
 * and including `boundary`, or null when none of them does.
 */
export function closestScroller(
  element: HTMLElement,
  boundary: HTMLElement
): HTMLElement | null {
  for (
    let current = element.parentElement;
    current !== null;
    current = current.parentElement
  ) {
    const { overflowY } = getComputedStyle(current);
    if (overflowY === "auto" || overflowY === "scroll") {
      return current;
    }
    if (current === boundary) {
      return null;
    }
  }
  return null;
}
