import type { RefObject } from "react";
import { useDomEvent } from "#src/hooks/effects";

/**
 * Whether an Escape belongs to a control inside the details column that closes
 * something of its own first: an open select, combobox, menu, template
 * autocomplete, or an element marked `data-owns-escape`, such as a step's open
 * list of actions.
 */
function escapeOwnedByControl(target: Element): boolean {
  return (
    target.matches('[aria-expanded="true"], [data-autocomplete-open="true"]') ||
    target.closest(
      '[role="listbox"], [role="menu"], [data-owns-escape="true"]'
    ) !== null
  );
}

/**
 * Escape inside the details panel, or on a phone inside the canvas area under
 * its sheets, takes one step back, unless an overlay, an
 * open control, or an earlier capture listener that called `preventDefault`
 * owns it. Escape is read in the document's capture phase and stopped once the
 * panel takes it, so no editor shortcut behind it sees the same key.
 */
export function useRevealKeyboard(input: {
  enabled: boolean;
  hasOverlays: boolean;
  /** The surface Escape must come from: the details panel or a phone's canvas area. */
  area: RefObject<HTMLElement | null>;
  onUnwind: () => void;
}): void {
  useDomEvent(
    document,
    "keydown",
    (event) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !input.enabled ||
        input.hasOverlays
      ) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const inArea =
        target === document.body ||
        (target !== null && input.area.current?.contains(target) === true);
      if (!inArea || (target !== null && escapeOwnedByControl(target))) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      input.onUnwind();
    },
    { capture: true }
  );
}
