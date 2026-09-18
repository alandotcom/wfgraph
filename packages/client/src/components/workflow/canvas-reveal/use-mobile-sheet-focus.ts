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
 * After Back, focus goes to the first of: the element the body already moved
 * focus to, inside the sheet or the canvas area, such as the row of the run
 * just left or the canvas node that opened the evidence; `backFocusTarget`;
 * the control that opened the removed sheet; the title of the sheet on screen.
 * A control focused after Back is scrolled into view when it is out of view.
 * A sheet whose control moved to another address, as Enter group does, gets
 * focus back on that control when its address shows again. Closing the last
 * sheet in the same address returns focus to its canvas node when focus had
 * been inside the sheet. `sheetKey` names the sheet on screen and is null while
 * none shows; `addressId` names the active address; a pending field request
 * moves focus itself. `onClickCapture` goes on the sheet element, where it
 * records the control each click used, and the shell calls `markBack` as Back
 * or Escape runs.
 */
export function useMobileSheetFocus(input: {
  state: MobileRevealState | null;
  sheetKey: string | null;
  addressId: string;
  fieldRequestPending: boolean;
  area: RefObject<HTMLElement | null>;
  sheet: RefObject<HTMLElement | null>;
  title: RefObject<HTMLHeadingElement | null>;
  backFocusTarget: ((sheet: HTMLElement) => HTMLElement | null) | undefined;
}): {
  onClickCapture: (event: MouseEvent<HTMLElement>) => void;
  markBack: () => void;
} {
  const { state } = input;
  /** The node the last shown sheet was about. */
  const lastNodeIdRef = useRef<string | null>(null);
  /** The control a click inside the shown sheet last used. */
  const lastUsedRef = useRef<Opener | null>(null);
  /**
   * The control that opened each sheet above the first, by address and depth,
   * so each scope keeps its own openers while another scope shows.
   */
  const openersRef = useRef(new Map<string, Map<number, Opener>>());
  /**
   * The address shown, with the key and depth of its shown sheet: a null key
   * and depth 0 while no sheet shows.
   */
  const shownRef = useRef<{
    addressId: string;
    sheetKey: string | null;
    depth: number;
  } | null>(null);
  /**
   * The control in a sheet that moved the canvas to another address, by the
   * address the sheet belongs to, with that sheet's key. It is kept until the
   * address shows another sheet or none.
   */
  const departuresRef = useRef(
    new Map<string, { opener: Opener; sheetKey: string }>()
  );
  /** The opener Back returns focus to once the sheet beneath has painted. */
  const returnToRef = useRef<Opener | null>(null);
  /**
   * The element focused when Back or Escape last ran, or null when the last
   * action in the sheet was something else.
   */
  const backFromRef = useRef<Element | null>(null);
  /**
   * Whether the sheet on screen replaced a deeper sheet, a sheet of another
   * address, or no sheet.
   */
  const unwoundRef = useRef(false);

  useBeforePaint(`${input.addressId}|${input.sheetKey ?? ""}`, () => {
    const depth = state?.depth ?? 0;
    const addressId = state?.addressId ?? input.addressId;
    const shown = shownRef.current;
    shownRef.current = { addressId, sheetKey: input.sheetKey, depth };
    const sameAddress = shown?.addressId === addressId;
    const previous = sameAddress ? shown.depth : 0;
    unwoundRef.current =
      !sameAddress || shown.sheetKey === null || depth < previous;
    const departures = departuresRef.current;
    if (shown?.sheetKey && !sameAddress && lastUsedRef.current) {
      departures.set(shown.addressId, {
        opener: lastUsedRef.current,
        sheetKey: shown.sheetKey,
      });
    }
    const departure = departures.get(addressId);
    if (departure && departure.sheetKey !== input.sheetKey) {
      departures.delete(addressId);
    }
    const openers =
      openersRef.current.get(addressId) ?? new Map<number, Opener>();
    returnToRef.current =
      !sameAddress && departure?.sheetKey === input.sheetKey
        ? departure.opener
        : depth > 0 && depth < previous
          ? (openers.get(depth + 1) ?? null)
          : null;
    for (const openerDepth of openers.keys()) {
      if (
        openerDepth > depth ||
        (sameAddress && depth === previous && openerDepth === depth)
      ) {
        openers.delete(openerDepth);
      }
    }
    if (depth > previous && previous > 0 && lastUsedRef.current) {
      openers.set(depth, lastUsedRef.current);
    }
    // An address keeps an entry only while it has an opener to return to.
    if (openers.size === 0) {
      openersRef.current.delete(addressId);
    } else {
      openersRef.current.set(addressId, openers);
    }
    lastUsedRef.current = null;

    if (state) {
      lastNodeIdRef.current = state.subject.nodeId;
      return;
    }
    const nodeId = lastNodeIdRef.current;
    lastNodeIdRef.current = null;
    const active = document.activeElement;
    // A sheet that closed because another address shows leaves focus to that
    // address, whose canvas no longer draws the sheet's node.
    if (
      nodeId !== null &&
      sameAddress &&
      (active === null || active === document.body)
    ) {
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
    const backFrom = backFromRef.current;
    backFromRef.current = null;
    if (!state || input.fieldRequestPending) {
      return;
    }
    const afterBack = backFrom !== null && unwoundRef.current;
    const active = document.activeElement;
    if (
      afterBack &&
      active instanceof HTMLElement &&
      active !== backFrom &&
      active !== title &&
      active !== document.body &&
      input.area.current?.contains(active)
    ) {
      return;
    }
    const kindTarget =
      afterBack && sheet ? (input.backFocusTarget?.(sheet) ?? null) : null;
    const opener = returnTo && sheet ? openerIn(sheet, returnTo) : null;
    const target = kindTarget ?? opener ?? title;
    if (target && document.activeElement !== target) {
      target.focus({ preventScroll: true });
      // The restored scroll stays unless the control Back focused is out of
      // view, as a change list row that Previous or Next moved to can be.
      if (target !== title) {
        target.scrollIntoView?.({ block: "nearest" });
      }
    }
  });

  return {
    markBack: () => {
      backFromRef.current = document.activeElement ?? document.body;
    },
    onClickCapture: (event) => {
      backFromRef.current = null;
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
