import { describe, expect, it, vi } from "vitest";
import {
  isWorkflowPublishDisabled,
  workflowCommands,
} from "#src/lib/workflow-commands";

function commandInput(
  overrides: Partial<Parameters<typeof workflowCommands>[0]["state"]> = {}
): Parameters<typeof workflowCommands>[0] {
  return {
    state: {
      canRedo: true,
      canReflow: true,
      canUndo: true,
      canSave: true,
      canViewChanges: true,
      canViewRuns: true,
      canPublish: true,
      canCopySelection: true,
      canPaste: true,
      canGroupSelection: true,
      currentWorkflowId: "workflow_1",
      editingLocked: false,
      hasNodes: true,
      isExecuting: false,
      isGenerating: false,
      isSaving: false,
      workflowMode: "live",
      ...overrides,
    },
    shortcuts: {
      copy: "Cmd+C",
      duplicate: "Cmd+D",
      fitView: "Cmd+/",
      group: "Cmd+G",
      palette: "Cmd+K",
      paste: "Cmd+V",
      redo: "Cmd+Shift+Z",
      run: "Cmd+Enter",
      save: "Cmd+S",
      undo: "Cmd+Z",
    },
    callbacks: {
      addStep: vi.fn(),
      copySelection: vi.fn(),
      duplicateSelection: vi.fn(),
      fitView: vi.fn(),
      groupSelection: vi.fn(),
      pasteSelection: vi.fn(),
      publish: vi.fn(),
      redo: vi.fn(),
      reflow: vi.fn(),
      run: vi.fn(),
      save: vi.fn(),
      showChanges: vi.fn(),
      showRuns: vi.fn(),
      switchMode: vi.fn(),
      undo: vi.fn(),
    },
  };
}

describe("workflowCommands", () => {
  it("includes save, workflow history, and publish commands", () => {
    const input = commandInput();
    const commands = workflowCommands(input);

    expect(commands.map((command) => command.id)).toEqual(
      expect.arrayContaining(["save", "show-runs", "show-changes", "publish"])
    );

    commands.find((command) => command.id === "save")?.execute();
    commands.find((command) => command.id === "show-runs")?.execute();
    commands.find((command) => command.id === "show-changes")?.execute();
    commands.find((command) => command.id === "publish")?.execute();

    expect(input.callbacks.save).toHaveBeenCalledOnce();
    expect(input.callbacks.showRuns).toHaveBeenCalledOnce();
    expect(input.callbacks.showChanges).toHaveBeenCalledOnce();
    expect(input.callbacks.publish).toHaveBeenCalledOnce();
  });

  it("includes every canvas shortcut action", () => {
    const input = commandInput();
    const commands = workflowCommands(input);

    expect(commands.map((command) => command.id)).toEqual(
      expect.arrayContaining([
        "fit-view",
        "copy-selection",
        "paste",
        "duplicate-selection",
        "group-selection",
      ])
    );

    commands.find((command) => command.id === "fit-view")?.execute();
    commands.find((command) => command.id === "copy-selection")?.execute();
    commands.find((command) => command.id === "paste")?.execute();
    commands.find((command) => command.id === "duplicate-selection")?.execute();
    commands.find((command) => command.id === "group-selection")?.execute();

    expect(input.callbacks.fitView).toHaveBeenCalledOnce();
    expect(input.callbacks.copySelection).toHaveBeenCalledOnce();
    expect(input.callbacks.pasteSelection).toHaveBeenCalledOnce();
    expect(input.callbacks.duplicateSelection).toHaveBeenCalledOnce();
    expect(input.callbacks.groupSelection).toHaveBeenCalledOnce();
  });

  it("omits mode switching until a workflow is available", () => {
    const commands = workflowCommands(
      commandInput({ currentWorkflowId: null })
    );

    expect(commands.map((command) => command.id)).not.toContain("mode");
  });

  it("derives one disabled policy for graph commands", () => {
    const commands = workflowCommands(commandInput({ editingLocked: true }));

    expect(
      commands.find((command) => command.id === "add-step")?.disabled
    ).toBe(true);
    expect(commands.find((command) => command.id === "undo")?.disabled).toBe(
      true
    );
    expect(commands.find((command) => command.id === "redo")?.disabled).toBe(
      true
    );
  });

  it("switches to the mode opposite the current one", () => {
    const input = commandInput({ workflowMode: "test" });
    const mode = workflowCommands(input).find(
      (command) => command.id === "mode"
    );

    expect(mode?.label).toBe("Switch to Live mode");
    mode?.execute();
    expect(input.callbacks.switchMode).toHaveBeenCalledWith("live");
  });
});

describe("isWorkflowPublishDisabled", () => {
  const publication = {
    isPublished: true,
    hasUnpublishedChanges: false,
    publishedVersionId: "version_1",
    publishedVersion: 1,
    publishedAt: "2026-08-23T16:00:00.000Z",
  };

  it("uses local unsaved changes when the published comparison is otherwise clean", () => {
    expect(
      isWorkflowPublishDisabled({
        editingLocked: false,
        isSaving: false,
        isComparing: false,
        isPublishing: false,
        hasNodes: true,
        hasUnsavedChanges: false,
        publication,
      })
    ).toBe(true);

    expect(
      isWorkflowPublishDisabled({
        editingLocked: false,
        isSaving: false,
        isComparing: false,
        isPublishing: false,
        hasNodes: true,
        hasUnsavedChanges: true,
        publication,
      })
    ).toBe(false);
  });
});
