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
      canEdit: true,
      canRunDraft: true,
      canRunPublished: true,
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
      isPreflighting: false,
      isGenerating: false,
      workflowMode: "live",
      publishedVersion: 7,
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
      runDraft: vi.fn(),
      runPublished: vi.fn(),
      save: vi.fn(),
      showChanges: vi.fn(),
      showRuns: vi.fn(),
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

  // Published mode is a setting, and the status strip is where it is read and
  // written. A command that flipped it would be a second writer.
  it("offers no command that changes Published mode", () => {
    const commands = workflowCommands(commandInput());

    expect(
      commands.some((command) => command.label.includes("Published mode"))
    ).toBe(false);
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

  /**
   * `consequential` marks the rows that reach real recipients. A surface that
   * highlights a row on its own reads this flag first. One row carries it: the
   * run of a version already in Live.
   */
  it("marks only the command that reaches real recipients", () => {
    const live = workflowCommands(commandInput({ workflowMode: "live" }));
    expect(
      live.find((command) => command.id === "run-published")?.consequential
    ).toBe(true);
    expect(live.find((command) => command.id === "run-published")?.detail).toBe(
      "Real recipients"
    );

    const test = workflowCommands(commandInput({ workflowMode: "test" }));
    expect(
      test.find((command) => command.id === "run-published")?.consequential
    ).toBe(false);
    expect(test.find((command) => command.id === "run-published")?.detail).toBe(
      "Test recipients"
    );
    expect(test.find((command) => command.id === "save")?.consequential).toBe(
      undefined
    );
  });

  // The toolbar's run control already offers both runs, so the Actions menu
  // skips them and the palette is where they are searched for by name.
  it("marks both run commands as belonging to the palette alone", () => {
    const commands = workflowCommands(commandInput());

    expect(
      commands.find((command) => command.id === "run-draft")?.paletteOnly
    ).toBe(true);
    expect(
      commands.find((command) => command.id === "run-published")?.paletteOnly
    ).toBe(true);
    expect(
      commands.find((command) => command.id === "publish")?.paletteOnly
    ).toBe(undefined);
  });

  // Nothing is published, so the published run reaches nobody.
  it("does not mark the published run before the first publish", () => {
    const commands = workflowCommands(
      commandInput({ workflowMode: "live", publishedVersion: undefined })
    );

    expect(
      commands.find((command) => command.id === "run-published")?.consequential
    ).toBe(false);
  });

  // Each run command starts the graph its label names. Nothing here reads the
  // publication state to pick a graph.
  it("offers both run commands, each labelled with the graph it starts", () => {
    const input = commandInput({ workflowMode: "test", publishedVersion: 7 });
    const commands = workflowCommands(input);
    const draft = commands.find((command) => command.id === "run-draft");
    const published = commands.find(
      (command) => command.id === "run-published"
    );

    expect(draft?.detail).toBe("Test recipients");
    expect(draft?.label).toBe("Run draft");
    expect(published?.label).toBe("Run v7 · Test");

    draft?.execute();
    published?.execute();
    expect(input.callbacks.runDraft).toHaveBeenCalledOnce();
    expect(input.callbacks.runPublished).toHaveBeenCalledOnce();
  });

  // The palette lists both commands flat, with no "Run options" heading, so a
  // disabled row must still name an action. The reason goes in the detail line
  // underneath.
  it("keeps Run draft available before the first publish and explains why the other is not", () => {
    const commands = workflowCommands(
      commandInput({ publishedVersion: undefined })
    );

    expect(
      commands.find((command) => command.id === "run-draft")?.disabled
    ).toBe(false);
    const published = commands.find(
      (command) => command.id === "run-published"
    );
    expect(published?.label).toBe("Run published version");
    expect(published?.detail).toBe("Nothing published yet");
    expect(published?.disabled).toBe(true);
  });

  // The preflight checks the canvas for the run about to execute it. Publish
  // already validated the published version, and a version is frozen.
  it("disables Run draft during its issue preflight and leaves the published run enabled", () => {
    const commands = workflowCommands(commandInput({ isPreflighting: true }));

    expect(
      commands.find((command) => command.id === "run-draft")?.disabled
    ).toBe(true);
    expect(
      commands.find((command) => command.id === "run-published")?.disabled
    ).toBe(false);
  });

  // A published version is a frozen graph that still handles Events. Clearing
  // the canvas or handing it to the build agent does not affect it.
  it("keeps the published run enabled while the canvas is empty or generating", () => {
    for (const canvas of [{ hasNodes: false }, { isGenerating: true }]) {
      const commands = workflowCommands(commandInput(canvas));

      expect(
        commands.find((command) => command.id === "run-draft")?.disabled
      ).toBe(true);
      expect(
        commands.find((command) => command.id === "run-published")?.disabled
      ).toBe(false);
    }
  });

  it("disables both run commands while a run is already in flight", () => {
    const commands = workflowCommands(commandInput({ isExecuting: true }));

    expect(
      commands.find((command) => command.id === "run-draft")?.disabled
    ).toBe(true);
    expect(
      commands.find((command) => command.id === "run-published")?.disabled
    ).toBe(true);
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
        isPreflighting: false,
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
        isPreflighting: false,
        hasNodes: true,
        hasUnsavedChanges: true,
        publication,
      })
    ).toBe(false);
  });

  it("disables Publish while issue preflight is active", () => {
    expect(
      isWorkflowPublishDisabled({
        editingLocked: false,
        isSaving: false,
        isComparing: false,
        isPublishing: false,
        isPreflighting: true,
        hasNodes: true,
        hasUnsavedChanges: true,
        publication,
      })
    ).toBe(true);
  });
});
