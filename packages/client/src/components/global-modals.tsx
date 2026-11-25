import { OverlayContainer } from "#src/components/overlays/overlay-container";
import { KeyboardShortcutsDialog } from "#src/components/keyboard-shortcuts-dialog";
import { useDomEvent } from "#src/hooks/effects";
import { recordFocusOpener } from "#src/lib/focus-return";

/**
 * Global modals and overlays that need to be rendered once at app level, and
 * the record of which control opened them, which every dialog reads when it
 * gives focus back.
 */
export function GlobalModals() {
  // Capture phase, so the record is written before a dialog opened by this
  // same press reads it.
  useDomEvent(document, "focusin", (event) => recordFocusOpener(event.target), {
    capture: true,
  });
  useDomEvent(
    document,
    "pointerdown",
    (event) => recordFocusOpener(event.target),
    { capture: true }
  );

  return (
    <>
      <OverlayContainer />
      <KeyboardShortcutsDialog />
    </>
  );
}
