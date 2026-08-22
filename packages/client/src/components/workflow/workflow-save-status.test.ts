import { describe, expect, it } from "vitest";
import {
  readSaveState,
  saveStatusLabel,
} from "#src/components/workflow/workflow-save-status";

const clean = {
  isSaving: false,
  hasUnsavedChanges: false,
  lastSaveError: null,
};

describe("readSaveState", () => {
  it("says saved when the queue is idle and nothing failed", () => {
    expect(readSaveState(clean)).toBe("saved");
  });

  it("says saving while a write is in flight, whatever else is true", () => {
    expect(
      readSaveState({
        isSaving: true,
        hasUnsavedChanges: true,
        lastSaveError: new Error("earlier"),
      })
    ).toBe("saving");
  });

  it("says failed even though the edit is also still unsaved", () => {
    // This is the shape every real failure has: the save store lowers the dirty
    // flag only on success, so a failed write always leaves both set. Reading
    // the dirty flag first is what made "Save failed" unreachable.
    expect(
      readSaveState({
        ...clean,
        hasUnsavedChanges: true,
        lastSaveError: new Error("boom"),
      })
    ).toBe("failed");
  });

  it("says unsaved once a newer edit has retired the failure", () => {
    // `saveWorkflowAtom` clears the error where it queues an edit, so this is
    // what the next keystroke after a failure looks like.
    expect(readSaveState({ ...clean, hasUnsavedChanges: true })).toBe(
      "unsaved"
    );
  });
});

describe("saveStatusLabel", () => {
  it("says when the settled state settled", () => {
    expect(saveStatusLabel("saved", new Date(2026, 7, 12, 12, 4))).toBe(
      "Saved 12:04"
    );
  });

  it("says plain Saved before this session has written anything", () => {
    expect(saveStatusLabel("saved", null)).toBe("Saved");
  });

  it("leaves the in-flight states timeless", () => {
    // These three are about a write happening now, so a clock reading beside
    // them would be the time of some earlier write.
    const savedAt = new Date(2026, 7, 12, 12, 4);
    expect(saveStatusLabel("saving", savedAt)).toBe("Saving");
    expect(saveStatusLabel("unsaved", savedAt)).toBe("Unsaved changes");
    expect(saveStatusLabel("failed", savedAt)).toBe("Save failed");
  });
});
