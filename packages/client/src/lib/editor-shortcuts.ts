/**
 * The rule every editor chord passes before it runs.
 *
 * An open dialog, menu, or command palette owns the keyboard, so no chord acts
 * on the editor behind it. A text field keeps the chords it has a meaning for
 * (undo, bold, copy), so only a chord with no meaning there (the palette,
 * save) runs from a text field.
 */

import { isTextEntry } from "#src/lib/is-text-entry";

/**
 * The layers that own the keyboard while they are in the document. The editor's
 * overlay container and the expanded agent panel mark themselves
 * `aria-modal`. Base UI's dialogs and menus mount their popups only while open
 * and set no `aria-modal`, so their `data-slot` names them. The canvas context
 * menu is a plain portal of its own.
 */
const KEYBOARD_LAYERS = [
  '[aria-modal="true"]',
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="dropdown-menu-sub-content"]',
  '[data-slot="canvas-context-menu"]',
].join(", ");

/** Whether a dialog, menu, or the command palette is open. */
export function keyboardLayerOpen(): boolean {
  return document.querySelector(KEYBOARD_LAYERS) !== null;
}

/** Whether `element` sits inside a dialog, menu, or the command palette. */
export function insideKeyboardLayer(element: Element): boolean {
  return element.closest(KEYBOARD_LAYERS) !== null;
}

/**
 * Whether `event` is Cmd+Enter or Ctrl+Enter with no other modifier, the chord
 * that submits the Run draft and Publish dialogs.
 */
export function isSubmitChord(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey
  );
}

/**
 * Whether an editor chord may act on this key event. `inTextFields` is true for
 * a chord with no meaning inside a text field, such as opening the palette or
 * saving; every other chord leaves a focused text field alone.
 */
export function editorChordAllowed(
  event: KeyboardEvent,
  options: { inTextFields: boolean }
): boolean {
  if (keyboardLayerOpen()) {
    return false;
  }
  return options.inTextFields || !isTextEntry(event.target);
}
