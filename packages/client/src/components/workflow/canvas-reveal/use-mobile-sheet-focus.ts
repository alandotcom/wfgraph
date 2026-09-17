import { type MouseEvent, type RefObject, useRef } from "react";
import { useAfterPaint, useBeforePaint } from "#src/hooks/effects";
import type { MobileRevealState } from "./canvas-reveal-state";

/** A control that opened a sheet, and the accessible name it goes by. */
type Opener = { element: HTMLElement; name: string };

const CONTROL_SELECTOR = "button, a[href], [role='button']";

function accessibleName(element: HTMLElement): string {
  return (
    element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""
  );
}

/**
 * The control in `sheet` that stands for `opener`: the element itself while
 * the sheet still holds it, or else the control with the same accessible name,
 * since a sheet shown again renders its controls anew.
 */
function openerIn(sheet: HTMLElement, opener: Opener): HTMLElement | null {
  if (opener.element.isConnected && sheet.contains(opener.element)) {
    return opener.element;
  }
  return (
    [...sheet.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)].find(
      (control) => accessibleName(control) === opener.name
    ) ?? null
  );
}

/**
 * Where keyboard focus goes as mobile Reveal sheets show. A sheet that opens
 * moves focus to its title, so a screen reader starts reading at that sheet.
 * Back returns focus to the control that opened the removed sheet, and to the
 * title of the sheet beneath when that control is gone. Closing the last sheet
 * returns focus to its canvas node when focus had been inside the sheet.
 * `sheetKey` names the sheet on screen and is null while none shows; a pending
 * field request moves focus itself. `onClickCapture` goes on the sheet element,
 * where it records the control each click used.
 */
export function useMobileSheetFocus(input: {
  state: MobileRevealState | null;
  sheetKey: string | null;
  fieldRequestPending: boolean;
  area: RefObject<HTMLElement | null>;
  sheet: RefObject<HTMLElement | null>;
  title: RefObject<HTMLHeadingElement | null>;
}): { onClickCapture: (event: MouseEvent<HTMLElement>) => void } {
  const { state } = input;
  /** The node the last shown sheet was about. */
  const lastNodeIdRef = useRef<string | null>(null);
  /** The control a click inside the shown sheet last used. */
  const lastUsedRef = useRef<Opener | null>(null);
  /** The control that opened each sheet above the first, by depth. */
  const openersRef = useRef(new Map<number, Opener>());
  const shownDepthRef = useRef(0);
  /** The opener Back returns focus to once the sheet beneath has painted. */
  const returnToRef = useRef<Opener | null>(null);

  useBeforePaint(input.sheetKey, () => {
    const depth = state?.depth ?? 0;
    const previous = shownDepthRef.current;
    const openers = openersRef.current;
    shownDepthRef.current = depth;
    returnToRef.current =
      depth > 0 && depth < previous ? (openers.get(depth + 1) ?? null) : null;
    for (const openerDepth of openers.keys()) {
      if (
        openerDepth > depth ||
        (depth === previous && openerDepth === depth)
      ) {
        openers.delete(openerDepth);
      }
    }
    if (depth > previous && previous > 0 && lastUsedRef.current) {
      openers.set(depth, lastUsedRef.current);
    }
    lastUsedRef.current = null;

    if (state) {
      lastNodeIdRef.current = state.subject.nodeId;
      return;
    }
    const nodeId = lastNodeIdRef.current;
    lastNodeIdRef.current = null;
    const active = document.activeElement;
    if (nodeId !== null && (active === null || active === document.body)) {
      input.area.current
        ?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`
        )
        ?.focus();
    }
  });

  useAfterPaint(input.sheetKey, () => {
    const title = input.title.current;
    const sheet = input.sheet.current;
    const returnTo = returnToRef.current;
    returnToRef.current = null;
    if (!state || input.fieldRequestPending) {
      return;
    }
    const opener = returnTo && sheet ? openerIn(sheet, returnTo) : null;
    const target = opener ?? title;
    if (target && document.activeElement !== target) {
      target.focus({ preventScroll: true });
    }
  });

  return {
    onClickCapture: (event) => {
      const control =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(CONTROL_SELECTOR)
          : null;
      if (control && event.currentTarget.contains(control)) {
        lastUsedRef.current = {
          element: control,
          name: accessibleName(control),
        };
      }
    },
  };
}
