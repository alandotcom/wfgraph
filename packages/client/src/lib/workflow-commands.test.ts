import { describe, expect, it, vi } from "vitest";
import { workflowCommands } from "#src/lib/workflow-commands";

function commandInput(
  overrides: Partial<Parameters<typeof workflowCommands>[0]["state"]> = {}
): Parameters<typeof workflowCommands>[0] {
  return {
    state: {
      canRedo: true,
      canReflow: true,
      canUndo: true,
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
      palette: "Cmd+K",
      redo: "Cmd+Shift+Z",
      run: "Cmd+Enter",
      undo: "Cmd+Z",
    },
    callbacks: {
      addStep: vi.fn(),
      redo: vi.fn(),
      reflow: vi.fn(),
      run: vi.fn(),
      switchMode: vi.fn(),
      undo: vi.fn(),
    },
  };
}

describe("workflowCommands", () => {
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
