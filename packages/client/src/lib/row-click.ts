import type { MouseEvent } from "react";

/** Elements that handle their own click inside a row that opens its item. */
const INNER_CONTROL =
  'a, button, input, label, [role="checkbox"], [role="menuitem"]';

/**
 * Whether a click on a list row should open the row's item.
 *
 * The row's own controls keep their clicks: a checkbox ticks and a menu opens
 * without the row navigating as well. React bubbles a click from a portalled
 * menu through the row that rendered it, so a click whose target sits outside
 * the row's DOM is refused too. A click with a modifier key is left alone,
 * because the row cannot open a new tab; the name's link does that.
 */
export function opensRow(event: MouseEvent<HTMLElement>): boolean {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const target = event.target;
  if (!(target instanceof Element && event.currentTarget.contains(target))) {
    return false;
  }
  return target.closest(INNER_CONTROL) === null;
}
