import {
  ArrowLeftRight,
  Play,
  Plus,
  Redo2,
  RefreshCcw,
  Undo2,
} from "lucide-react";
import type { EditorShortcutLabels } from "#src/lib/shortcut-label";
import type { WorkflowMode } from "#src/lib/workflow-graph-types";

export type WorkflowCommandId =
  | "add-step"
  | "run"
  | "mode"
  | "undo"
  | "redo"
  | "reflow";

export type WorkflowCommand = {
  readonly id: WorkflowCommandId;
  readonly group: "steps" | "workflow";
  readonly label: string;
  readonly detail?: string;
  readonly keywords: string;
  readonly hint?: string;
  readonly disabled: boolean;
  readonly execute: () => void;
};

type WorkflowCommandState = {
  readonly currentWorkflowId: string | null;
  readonly workflowMode: WorkflowMode;
  readonly isExecuting: boolean;
  readonly isGenerating: boolean;
  readonly isSaving: boolean;
  readonly hasNodes: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly canReflow: boolean;
  readonly editingLocked: boolean;
};

type WorkflowCommandCallbacks = {
  readonly addStep: () => void;
  readonly run: () => void;
  readonly switchMode: (mode: WorkflowMode) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly reflow: () => void;
};

/** The command policy shared by the menu and command palette. */
export function workflowCommands({
  state,
  shortcuts,
  callbacks,
}: {
  state: WorkflowCommandState;
  shortcuts: EditorShortcutLabels;
  callbacks: WorkflowCommandCallbacks;
}): readonly WorkflowCommand[] {
  const runDisabled =
    state.isExecuting ||
    !state.hasNodes ||
    state.isGenerating ||
    !state.currentWorkflowId;
  const otherMode: WorkflowMode =
    state.workflowMode === "live" ? "test" : "live";

  return [
    {
      id: "add-step",
      group: "steps",
      label: "Add step",
      detail: "Pick what the new step does",
      keywords: "Add step node action new create insert",
      disabled: state.editingLocked,
      execute: callbacks.addStep,
    },
    {
      id: "run",
      group: "workflow",
      label: "Run workflow",
      keywords: "Run workflow execute test start trigger",
      hint: shortcuts.run,
      disabled: runDisabled,
      execute: callbacks.run,
    },
    ...(state.currentWorkflowId
      ? [
          {
            id: "mode" as const,
            group: "workflow" as const,
            label: `Switch to ${otherMode === "live" ? "Live" : "Test"} mode`,
            keywords: `Switch mode live test ${otherMode}`,
            disabled: state.isSaving || state.isGenerating,
            execute: () => callbacks.switchMode(otherMode),
          },
        ]
      : []),
    {
      id: "undo",
      group: "workflow",
      label: "Undo",
      keywords: "Undo revert back",
      hint: shortcuts.undo,
      disabled: !state.canUndo || state.editingLocked,
      execute: callbacks.undo,
    },
    {
      id: "redo",
      group: "workflow",
      label: "Redo",
      keywords: "Redo forward again",
      hint: shortcuts.redo,
      disabled: !state.canRedo || state.editingLocked,
      execute: callbacks.redo,
    },
    {
      id: "reflow",
      group: "workflow",
      label: "Tidy layout",
      keywords: "Tidy layout arrange align auto layout clean up",
      disabled: !state.canReflow,
      execute: callbacks.reflow,
    },
  ];
}

/** One visual vocabulary for commands rendered in different surfaces. */
export function WorkflowCommandIcon({
  id,
  className,
}: {
  id: WorkflowCommandId;
  className?: string;
}) {
  switch (id) {
    case "add-step":
      return <Plus className={className} />;
    case "run":
      return <Play className={className} />;
    case "mode":
      return <ArrowLeftRight className={className} />;
    case "undo":
      return <Undo2 className={className} />;
    case "redo":
      return <Redo2 className={className} />;
    case "reflow":
      return <RefreshCcw className={className} />;
    default:
      return null;
  }
}
