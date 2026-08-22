/**
 * Whether the canvas on screen is the canvas on the server.
 *
 * The Save button used to carry this as a 2px dot in its corner, which said
 * "something is unsaved" only to a reader who already knew the dot meant that.
 * A word says it instead, and the same component owns the guard that stops a
 * reload from discarding the pending patch behind it.
 */

import { useAtomValue } from "jotai";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useDomEvent } from "#src/hooks/effects";
import {
  hasUnsavedChangesAtom,
  isSavingAtom,
  isWorkflowOwnerAtom,
  lastSaveErrorAtom,
} from "#src/lib/workflow-save-store";

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

const STATUS_VARIANTS: Record<
  Exclude<SaveState, "saving">,
  "error" | "neutral" | "success" | "warning"
> = {
  unsaved: "warning",
  failed: "error",
  saved: "success",
};

export function WorkflowSaveStatus() {
  const isSaving = useAtomValue(isSavingAtom);
  const hasUnsavedChanges = useAtomValue(hasUnsavedChangesAtom);
  const lastSaveError = useAtomValue(lastSaveErrorAtom);
  const isOwner = useAtomValue(isWorkflowOwnerAtom);

  const state = readSaveState({ isSaving, hasUnsavedChanges, lastSaveError });

  // Autosave is debounced a second, so a reload landing inside that window used
  // to drop the edit without a word. `preventDefault` alone arms the browser's
  // own confirmation; the wording belongs to the browser and cannot be set, and
  // the `returnValue` that used to be needed beside it is deprecated.
  //
  // Owners only. Nothing on the canvas stops a viewer of a public workflow from
  // dragging a node, and the save that follows is refused by the server without
  // ever lowering the dirty flag -- so on a read-only page this would arm a
  // leave-prompt the viewer could never satisfy.
  useDomEvent(
    window,
    "beforeunload",
    (event) => {
      event.preventDefault();
    },
    { enabled: isOwner && (hasUnsavedChanges || isSaving) }
  );

  if (!isOwner) {
    return null;
  }

  return (
    // A live region, because this is the one control that changes on its own
    // while the user is looking somewhere else.
    <output aria-live="polite">
      <HStack gap={1.5}>
        {state === "saving" ? (
          <Spinner aria-label="Saving workflow" size="sm" />
        ) : (
          <StatusDot label={LABELS[state]} variant={STATUS_VARIANTS[state]} />
        )}
        <Text color="secondary" type="supporting">
          {LABELS[state]}
        </Text>
      </HStack>
    </output>
  );
}
