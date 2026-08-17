import { useSetAtom } from "jotai";
import { useCallback } from "react";
import { useDomEvent } from "#src/hooks/effects";
import { isTextEntry } from "#src/lib/is-text-entry";
import {
  copySelectionAtom,
  duplicateSelectionAtom,
  pasteCopiedSelectionAtom,
} from "#src/lib/workflow-graph-store";

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
      if (isTextEntry(event.target)) {
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
