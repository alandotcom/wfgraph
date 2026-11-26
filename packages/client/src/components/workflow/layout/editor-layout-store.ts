/**
 * What the editor below the toolbar shows besides the canvas: whether the
 * floating outline is hidden, and on a phone whether the map replaces the
 * outline. None of it is kept across reloads or workflows. Whether the
 * Inspector card is open derives from its subject, in `canvas-reveal-state.ts`.
 */

import { atom, type Getter } from "jotai";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";

/**
 * Whether a phone shows the canvas, which the toolbar's Map control chooses,
 * in place of the outline.
 */
export const phoneShowsMapAtom = atom(false);

/** The open workflow and its view, such as `workflow_1|draft`. */
function outlineScope(get: Getter): string {
  return `${get(currentWorkflowIdAtom) ?? ""}|${get(workflowWorkspaceViewAtom)}`;
}

/** The `outlineScope` the outline was hidden in, or null while it shows. */
const outlineHiddenScopeAtom = atom<string | null>(null);

/**
 * Whether the person hid the outline floating over the canvas with `[` or its
 * palette command. It holds only in the workflow and view it was hidden in:
 * another workflow, or Runs after hiding it in Draft, shows the outline, and
 * coming back to that workflow's Draft finds it hidden as it was left.
 * "Find a step" shows it again. The run list ignores it, because the list is
 * the only way to open a run. Leaving the editor shows it again.
 */
export const outlineHiddenAtom = atom(
  (get) => get(outlineHiddenScopeAtom) === outlineScope(get),
  (get, set, hidden: boolean) => {
    set(outlineHiddenScopeAtom, hidden ? outlineScope(get) : null);
  }
);

/**
 * Whether Cmd+F or "Find a step" has asked for the outline's filter field and
 * the outline has not answered yet. The outline shows the field, puts the
 * cursor in it, and clears the request.
 */
export const outlineFilterFocusRequestAtom = atom(false);
