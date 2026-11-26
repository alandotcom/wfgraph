import { useAtomValue, useSetAtom, useStore } from "jotai";
import type { MouseEvent } from "react";
import { requestRevealPlacementAtom } from "#src/components/workflow/canvas-reveal/reveal-requests";
import { runEvidenceOriginAtom } from "#src/components/workflow/run-evidence-origin";
import { useFocusWorkflowNode } from "#src/components/workflow/use-focus-workflow-node";
import { useInspectRunNode } from "#src/components/workflow/use-run-node-evidence";
import { contextMenuAtom } from "#src/components/workflow/workflow-context-menu";
import { expandGroupAtom } from "#src/lib/collapsed-groups";
import { editOfNode, type workflowEdits } from "#src/lib/workflow-edits";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import { workspaceAddressId } from "#src/lib/workflow-navigation-state";
import {
  requestReviewScrollAtom,
  reviewHighlightAtom,
} from "#src/lib/workflow-review-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
} from "#src/lib/workflow-workspace-navigation";
import { isNodeRow, type OutlineDisplayRow } from "./outline-view";

/** The step a row stands for: its own, or the one a reference leads to. */
export function outlineRowNodeId(row: OutlineDisplayRow): string | null {
  if (isNodeRow(row)) return row.nodeId;
  return row.kind === "continues" ? row.targetNodeId : null;
}

export type OutlineRowGestures = {
  /**
   * Select the step a row stands for, as a press on its card would. In
   * Draft it selects the step and opens it in the Inspector; on a run it
   * shows the step's evidence; while the review sheet shows it scrolls the
   * sheet to the step's edit. A reference row goes to the row it refers to.
   */
  choose: (row: OutlineDisplayRow) => void;
  /**
   * Shift-click adds the row's step to the selection and Cmd-click or
   * Ctrl-click adds or removes it, as on the canvas. Answers whether the
   * click was one of those, which only `authoring` allows.
   */
  extendSelection: (row: OutlineDisplayRow, event: MouseEvent) => boolean;
  /**
   * Right-click opens the step's context menu, the one its canvas card opens,
   * when `authoring`. A row outside the selection becomes the selection
   * first; a row inside it keeps the selection, so the menu offers the
   * commands for all of it, each naming the count.
   */
  openRowMenu: (row: OutlineDisplayRow, event: MouseEvent) => void;
};

/**
 * What a click, a modified click and a right-click on an outline row do, the
 * same gestures its canvas card answers. `revealRow` unfolds and focuses the
 * row a reference row leads to, since the outline owns its folds and focus.
 */
export function useOutlineRowGestures(input: {
  /** Whether the canvas takes topology edits now, from `useCanvasInteraction`. */
  authoring: boolean;
  /** Whether the review sheet shows, which takes the canvas's selection. */
  reviewShown: boolean;
  /** The changes the review sheet shows, or null while none has arrived. */
  edits: ReturnType<typeof workflowEdits> | null;
  revealRow: (nodeId: string) => void;
}): OutlineRowGestures {
  const store = useStore();
  const view = useAtomValue(workflowWorkspaceViewAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const focusNode = useFocusWorkflowNode();
  const inspectRunNode = useInspectRunNode();
  const requestPlacement = useSetAtom(requestRevealPlacementAtom);
  const setHighlight = useSetAtom(reviewHighlightAtom);
  const requestReviewScroll = useSetAtom(requestReviewScrollAtom);
  const setContextMenu = useSetAtom(contextMenuAtom);
  const { authoring, reviewShown, edits } = input;

  const choose = (row: OutlineDisplayRow) => {
    const nodeId = outlineRowNodeId(row);
    if (nodeId === null) return;
    if (row.kind === "continues") {
      input.revealRow(nodeId);
    }
    if (reviewShown) {
      // The canvas holds no selection while the sheet shows, so a changed
      // row scrolls the sheet to its edit, as a press on its card does.
      setHighlight(nodeId);
      if (edits && editOfNode(edits, nodeId)) requestReviewScroll(nodeId);
      return;
    }
    if (view === "runs") {
      // On a run the row shows the step's evidence on the one canvas, and
      // Back and Escape return to the row. A step in a Group the viewer
      // collapsed draws its Group in place again.
      inspectRunNode({ nodeId, logId: null });
      const origin = store.get(runEvidenceOriginAtom);
      if (origin?.nodeId === nodeId) {
        store.set(runEvidenceOriginAtom, { ...origin, fromOutline: true });
      }
      const parentId = store
        .get(executionOverlayGraphAtom)
        ?.nodes.find((node) => node.id === nodeId)?.parentId;
      if (parentId !== undefined) {
        store.set(expandGroupAtom, parentId);
      }
      requestPlacement({
        addressId: workspaceAddressId(store.get(activeWorkspaceAddressAtom)),
        nodeIds: [nodeId],
      });
      return;
    }
    if (workflowId !== null) {
      focusNode({ nodeId, workflowId });
    }
  };

  const extendSelection = (row: OutlineDisplayRow, event: MouseEvent) => {
    if (
      !(authoring && isNodeRow(row)) ||
      !(event.shiftKey || event.metaKey || event.ctrlKey)
    ) {
      return false;
    }
    const current = store.get(activeSelectionAtom).nodeIds;
    const holds = current.includes(row.nodeId);
    const nodeIds =
      holds && !event.shiftKey
        ? current.filter((id) => id !== row.nodeId)
        : holds
          ? current
          : [...current, row.nodeId];
    store.set(activeSelectionAtom, { nodeIds, edgeIds: [] });
    return true;
  };

  const openRowMenu = (row: OutlineDisplayRow, event: MouseEvent) => {
    if (!(authoring && isNodeRow(row))) return;
    event.preventDefault();
    const current = store.get(activeSelectionAtom).nodeIds;
    const keeps = current.includes(row.nodeId);
    if (!keeps) {
      store.set(activeSelectionAtom, { nodeIds: [row.nodeId], edgeIds: [] });
    }
    setContextMenu({
      type: "node",
      position: { x: event.clientX, y: event.clientY },
      nodeId: row.nodeId,
      selectedIds: new Set(keeps ? current : [row.nodeId]),
    });
  };

  return { choose, extendSelection, openRowMenu };
}
