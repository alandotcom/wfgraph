import type { RefObject } from "react";
import { useDomEvent } from "#src/hooks/effects";
import type { RevealLevel } from "#src/lib/workflow-navigation-state";
import { CANVAS_OBSTACLE_SLOTS } from "./reveal-geometry";

/**
 * Whether an Escape belongs to a control inside Reveal that closes something
 * of its own first: an open select, combobox, menu, or template autocomplete.
 */
function escapeOwnedByControl(target: Element): boolean {
  return (
    target.matches('[aria-expanded="true"], [data-autocomplete-open="true"]') ||
    target.closest('[role="listbox"], [role="menu"]') !== null
  );
}

/**
 * Canvas Reveal's keys. Cmd+B or Ctrl+B toggles Reveal. Escape inside the canvas
 * area unwinds one level, unless an overlay, the agent panel, an open control,
 * or an earlier capture listener that called `preventDefault` owns it. Escape is
 * read in the document's capture phase and stopped once Reveal takes it, so a
 * focused React Flow node never sees it and keeps its selection.
 */
export function useRevealKeyboard(input: {
  /** False below `md`, where Reveal is not mounted. */
  enabled: boolean;
  level: RevealLevel;
  hasOverlays: boolean;
  /** The canvas area Escape must come from: the Reveal surface's parent. */
  area: RefObject<HTMLElement | null>;
  onToggle: () => void;
  onUnwind: () => void;
}): void {
  useDomEvent(window, "keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "b") {
      event.preventDefault();
      if (input.enabled) {
        input.onToggle();
      }
    }
  });

  useDomEvent(
    document,
    "keydown",
    (event) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !input.enabled ||
        input.hasOverlays ||
        input.level === "closed"
      ) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const inArea =
        target === document.body ||
        (target !== null && input.area.current?.contains(target) === true);
      if (
        !inArea ||
        (target !== null &&
          (target.closest(
            `[data-slot="${CANVAS_OBSTACLE_SLOTS.agentPanel}"]`
          ) !== null ||
            escapeOwnedByControl(target)))
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      input.onUnwind();
    },
    { capture: true }
  );
}
