import { useSetAtom } from "jotai";
import { useCallback } from "react";
import { useDomEvent } from "#src/hooks/effects";
import {
  copySelectionAtom,
  duplicateSelectionAtom,
  pasteCopiedSelectionAtom,
} from "#src/lib/workflow-graph-store";

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable)
  );
}

/**
 * Cmd/Ctrl+C, V, and D for the canvas selection. Disabled while a run overlay
 * or generation owns the canvas, and skipped while a field is being typed in.
 */
export function useCanvasCopyPaste(enabled: boolean) {
  const copySelection = useSetAtom(copySelectionAtom);
  const pasteSelection = useSetAtom(pasteCopiedSelectionAtom);
  const duplicateSelection = useSetAtom(duplicateSelectionAtom);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) {
        return;
      }
      if (isTypingTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "c") {
        if (copySelection()) {
          event.preventDefault();
        }
        return;
      }
      if (key === "v") {
        if (pasteSelection()) {
          event.preventDefault();
        }
        return;
      }
      if (key === "d" && duplicateSelection()) {
        event.preventDefault();
      }
    },
    [copySelection, pasteSelection, duplicateSelection]
  );

  useDomEvent(window, "keydown", onKeyDown, { enabled });
}
