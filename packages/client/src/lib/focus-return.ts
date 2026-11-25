/**
 * The control a closing dialog gives focus back to.
 *
 * Several dialogs open some time after the press that asked for them. Publish
 * saves and checks the draft first, and a palette row closes the palette before
 * its dialog opens. By then the pressed control can be disabled, unmounted, or
 * inside the palette, so `document.activeElement` at open time no longer names
 * it. This module records the last control a person focused or pressed outside
 * every dialog, menu and palette, and the dialogs return focus to that control.
 * `GlobalModals` feeds it from the document's `focusin` and `pointerdown`.
 */

import { insideKeyboardLayer } from "#src/lib/editor-shortcuts";

/** Elements that can take focus, the selector the focus trap walks as well. */
export const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

/** Like `FOCUSABLE`, and also an element that takes focus only from a script or a click. */
const FOCUS_TARGET = `${FOCUSABLE},[tabindex="-1"]`;

let opener: HTMLElement | null = null;

/**
 * Record what `target` says about the opener: the control it sits in, or no
 * control at all when it is plain page or canvas. A target inside a dialog,
 * menu or palette leaves the record alone, because those are what open and
 * close around the opener.
 */
export function recordFocusOpener(target: EventTarget | null): void {
  if (!(target instanceof Element) || insideKeyboardLayer(target)) {
    return;
  }
  opener = target.closest<HTMLElement>(FOCUS_TARGET);
}

/**
 * The control to give focus back to, or null when the last press landed on no
 * control or that control has left the page.
 */
export function focusOpener(): HTMLElement | null {
  return opener?.isConnected ? opener : null;
}

/**
 * The `finalFocus` every dialog wrapper in `components/ui` passes Base UI: the
 * recorded opener, or Base UI's own choice when there is none. When another
 * dialog or menu already holds focus, such as one a palette row opened, focus
 * stays there.
 */
export function dialogFinalFocus(): HTMLElement | boolean {
  const active = document.activeElement;
  if (
    active instanceof Element &&
    active !== document.body &&
    insideKeyboardLayer(active) &&
    // The closing dialog itself, which Base UI marks while it animates out.
    active.closest("[data-closed]") === null
  ) {
    return false;
  }
  return focusOpener() ?? true;
}
