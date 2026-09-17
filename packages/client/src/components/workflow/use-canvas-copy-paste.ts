import { useSetAtom } from "jotai";
import { useCallback } from "react";
import { useDomEvent } from "#src/hooks/effects";
import { isTextEntry } from "#src/lib/is-text-entry";
import { showGraphEditRefusal } from "#src/components/workflow/graph-edit-refusal";
import {
  copySelectionAtom,
  duplicateSelectionAtom,
  groupSelectionAtom,
  pasteCopiedSelectionAtom,
} from "#src/lib/workflow-graph-store";

/**
 * Cmd/Ctrl+C, V, D, and G for the canvas selection. Disabled while a run overlay
 * or generation owns the canvas, and skipped while a field is being typed in.
 * Paste and duplicate insert steps, so they wait for `insertsNodes`, and a
 * refused paste or duplicate shows its refusal.
 */
export function useCanvasCopyPaste(input: {
  enabled: boolean;
  insertsNodes: boolean;
}) {
  const { enabled, insertsNodes } = input;
  const copySelection = useSetAtom(copySelectionAtom);
  const pasteSelection = useSetAtom(pasteCopiedSelectionAtom);
  const duplicateSelection = useSetAtom(duplicateSelectionAtom);
  const groupSelection = useSetAtom(groupSelectionAtom);

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
      if (key === "v" || key === "d") {
        const outcome = insertsNodes
          ? key === "v"
            ? pasteSelection()
            : duplicateSelection()
          : null;
        if (outcome !== null) {
          event.preventDefault();
          showGraphEditRefusal(outcome);
        }
        return;
      }
      if (key === "g" && groupSelection()) {
        event.preventDefault();
      }
    },
    [
      copySelection,
      pasteSelection,
      duplicateSelection,
      groupSelection,
      insertsNodes,
    ]
  );

  useDomEvent(window, "keydown", onKeyDown, { enabled });
}
