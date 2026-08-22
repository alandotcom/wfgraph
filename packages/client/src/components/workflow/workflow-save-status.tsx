/**
 * Whether the canvas on screen is the canvas on the server.
 *
 * The Save button used to carry this as a 2px dot in its corner, which said
 * "something is unsaved" only to a reader who already knew the dot meant that.
 * A word says it instead.
 *
 * Two components, because they have different lifetimes. `WorkflowSaveStatus`
 * is a label the status strip mounts inside whichever of its two states is up;
 * `WorkflowUnloadGuard` is headless and mounts once, outside them, because a
 * reload discards a pending patch whether or not the label reporting it happens
 * to be on screen.
 */

import { useAtomValue } from "jotai";
import { Loader2 } from "lucide-react";
import { useDomEvent } from "#src/hooks/effects";
import {
  hasUnsavedChangesAtom,
  isSavingAtom,
  isWorkflowOwnerAtom,
  lastSaveErrorAtom,
  lastSavedAtAtom,
} from "#src/lib/workflow-save-store";
import { cn } from "@wfgraph/shared/utils";
import { formatClockTime } from "@wfgraph/shared/utils/time";

type SaveState = "saving" | "unsaved" | "failed" | "saved";

/** The four states as one pure decision, so they can be read without a DOM. */
export function readSaveState(input: {
  isSaving: boolean;
  hasUnsavedChanges: boolean;
  lastSaveError: Error | null;
}): SaveState {
  if (input.isSaving) {
    return "saving";
  }
  // The failure is read before the dirty flag, because a failed save leaves the
  // edit unsaved by definition -- the save store lowers that flag only on
  // success. Asking about the dirty flag first would mean "Save failed" named a
  // state nothing could reach. A newer edit clears the error where it is
  // queued, so red here always means the last attempt failed.
  if (input.lastSaveError) {
    return "failed";
  }
  if (input.hasUnsavedChanges) {
    return "unsaved";
  }
  return "saved";
}

const LABELS: Record<SaveState, string> = {
  saving: "Saving",
  unsaved: "Unsaved changes",
  failed: "Save failed",
  saved: "Saved",
};

/**
 * What the strip says, which is the state plus the time the settled one settled.
 *
 * "Saved" on its own is true of a workflow left open all afternoon, so it stops
 * answering the question a builder is actually asking. The other three states
 * are about a write happening now and carry no time.
 */
export function saveStatusLabel(
  state: SaveState,
  lastSavedAt: Date | null
): string {
  if (state === "saved" && lastSavedAt) {
    return `Saved ${formatClockTime(lastSavedAt)}`;
  }
  return LABELS[state];
}

const TONES: Record<SaveState, string> = {
  saving: "",
  unsaved: "text-warning",
  failed: "text-destructive",
  saved: "",
};

/**
 * Arms the browser's own leave-confirmation while a patch is still in flight.
 *
 * Autosave is debounced a second, so a reload landing inside that window used to
 * drop the edit without a word. `preventDefault` alone arms the confirmation;
 * the wording belongs to the browser and cannot be set, and the `returnValue`
 * that used to sit beside it is deprecated.
 *
 * Mounted unconditionally, above whatever the strip is currently showing. It
 * used to live inside the label below, which meant pinning a run to the canvas
 * unmounted the label and disarmed the guard with it: an edit made inside the
 * debounce window and then followed by a click on a run was dropped silently.
 *
 * Owners only. Nothing on the canvas stops a viewer of a public workflow from
 * dragging a node, and the save that follows is refused by the server without
 * ever lowering the dirty flag -- so on a read-only page this would arm a
 * leave-prompt the viewer could never satisfy.
 */
export function WorkflowUnloadGuard() {
  const isSaving = useAtomValue(isSavingAtom);
  const hasUnsavedChanges = useAtomValue(hasUnsavedChangesAtom);
  const isOwner = useAtomValue(isWorkflowOwnerAtom);

  useDomEvent(
    window,
    "beforeunload",
    (event) => {
      event.preventDefault();
    },
    { enabled: isOwner && (hasUnsavedChanges || isSaving) }
  );

  return null;
}

export function WorkflowSaveStatus() {
  const isSaving = useAtomValue(isSavingAtom);
  const hasUnsavedChanges = useAtomValue(hasUnsavedChangesAtom);
  const lastSaveError = useAtomValue(lastSaveErrorAtom);
  const lastSavedAt = useAtomValue(lastSavedAtAtom);
  const isOwner = useAtomValue(isWorkflowOwnerAtom);

  const state = readSaveState({ isSaving, hasUnsavedChanges, lastSaveError });

  if (!isOwner) {
    return null;
  }

  return (
    // Plain text. The strip as a whole is one polite live region, so this needs
    // no region of its own; a second one nested inside it would announce the
    // same change twice.
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 whitespace-nowrap",
        TONES[state]
      )}
    >
      {state === "saving" && <Loader2 className="size-3 animate-spin" />}
      {saveStatusLabel(state, lastSavedAt)}
    </span>
  );
}
