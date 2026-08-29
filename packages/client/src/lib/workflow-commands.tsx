import {
  ArrowLeftRight,
  CirclePlay,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Group,
  History,
  Maximize2,
  Play,
  Plus,
  Redo2,
  RefreshCcw,
  Save,
  Undo2,
  Upload,
} from "lucide-react";
import type { EditorShortcutLabels } from "#src/lib/shortcut-label";
import type { WorkflowMode } from "#src/lib/workflow-graph-types";
import {
  NOTHING_PUBLISHED_LABEL,
  publishedRunLabel,
} from "#src/lib/workflow-run-labels";

export type WorkflowCommandId =
  | "add-step"
  | "save"
  | "run-draft"
  | "run-published"
  | "mode"
  | "show-runs"
  | "show-changes"
  | "publish"
  | "undo"
  | "redo"
  | "reflow"
  | "fit-view"
  | "copy-selection"
  | "paste"
  | "duplicate-selection"
  | "group-selection";

export type WorkflowCommand = {
  readonly id: WorkflowCommandId;
  readonly group: "steps" | "workflow" | "canvas";
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
  /** The published version's number, absent until the first publish. */
  readonly publishedVersion?: number;
  readonly isExecuting: boolean;
  readonly isPreflighting: boolean;
  readonly isGenerating: boolean;
  readonly isSaving: boolean;
  readonly hasNodes: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly canReflow: boolean;
  readonly canSave: boolean;
  readonly canViewRuns: boolean;
  readonly canViewChanges: boolean;
  readonly canPublish: boolean;
  readonly canCopySelection: boolean;
  readonly canPaste: boolean;
  readonly canGroupSelection: boolean;
  readonly editingLocked: boolean;
};

type WorkflowCommandCallbacks = {
  readonly addStep: () => void;
  readonly save: () => void;
  readonly runDraft: () => void;
  readonly runPublished: () => void;
  readonly switchMode: (mode: WorkflowMode) => void;
  readonly showRuns: () => void;
  readonly showChanges: () => void;
  readonly publish: () => void;
  readonly fitView: () => void;
  readonly copySelection: () => void;
  readonly pasteSelection: () => void;
  readonly duplicateSelection: () => void;
  readonly groupSelection: () => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly reflow: () => void;
};

type PublishEligibility = {
  readonly editingLocked: boolean;
  readonly isSaving: boolean;
  readonly isComparing: boolean;
  readonly isPublishing: boolean;
  readonly isPreflighting: boolean;
  readonly hasNodes: boolean;
  readonly hasUnsavedChanges: boolean;
  readonly publication?: {
    readonly isPublished: boolean;
    readonly hasUnpublishedChanges: boolean;
  };
};

/** The publish gate shared by the command controller and toolbar button. */
export function isWorkflowPublishDisabled({
  editingLocked,
  isSaving,
  isComparing,
  isPublishing,
  isPreflighting,
  hasNodes,
  hasUnsavedChanges,
  publication,
}: PublishEligibility): boolean {
  return (
    editingLocked ||
    isSaving ||
    isComparing ||
    isPublishing ||
    isPreflighting ||
    !hasNodes ||
    Boolean(
      publication?.isPublished &&
      !publication.hasUnpublishedChanges &&
      !hasUnsavedChanges
    )
  );
}

/**
 * Everything either Run verb is judged on. One shape, so a surface offering
 * both asks the two questions of the same facts.
 */
export type WorkflowRunEligibility = {
  readonly currentWorkflowId: string | null;
  readonly isExecuting: boolean;
  readonly isPreflighting: boolean;
  readonly isGenerating: boolean;
  readonly hasNodes: boolean;
  /** The published version's number, absent until the first publish. */
  readonly publishedVersion?: number;
};

/**
 * What both verbs need: a saved workflow, and no run of this editor's already
 * in flight. Nothing about the canvas belongs here, because the published
 * version is a frozen graph the canvas cannot reach.
 */
function isRunUnavailable(state: WorkflowRunEligibility): boolean {
  return state.isExecuting || !state.currentWorkflowId;
}

/**
 * Run draft's gate, which is where every canvas fact lives: an empty canvas has
 * no draft to run, a generating one is being rewritten under the press, and the
 * issue preflight is this verb's own check.
 */
export function isDraftRunDisabled(state: WorkflowRunEligibility): boolean {
  return (
    isRunUnavailable(state) ||
    !state.hasNodes ||
    state.isGenerating ||
    state.isPreflighting
  );
}

/**
 * Run v7's gate. Its one condition of its own is that something is published:
 * a published version is immutable, so nothing the builder does to the canvas
 * can hold it back.
 */
export function isPublishedRunDisabled(state: WorkflowRunEligibility): boolean {
  return isRunUnavailable(state) || state.publishedVersion === undefined;
}

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
  const otherMode: WorkflowMode =
    state.workflowMode === "live" ? "test" : "live";
  const hasPublishedVersion = state.publishedVersion !== undefined;

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
      id: "save",
      group: "workflow",
      label: "Save workflow",
      keywords: "Save workflow changes",
      hint: shortcuts.save,
      disabled: !state.canSave,
      execute: callbacks.save,
    },
    {
      id: "run-draft",
      group: "workflow",
      label: "Run draft",
      detail: "Runs the canvas with test recipients",
      keywords: "Run draft canvas execute test start trigger",
      hint: shortcuts.run,
      disabled: isDraftRunDisabled(state),
      execute: callbacks.runDraft,
    },
    {
      id: "run-published",
      group: "workflow",
      // Named for the version and the Published mode it honours, which is what
      // separates it from the verb above. The label stays a verb before the
      // first publish: this row is listed flat beside "Run draft" in the
      // Actions menu and the palette, where a bare "Nothing published yet"
      // would name no action at all. The reason goes in the detail those two
      // surfaces print underneath.
      label: hasPublishedVersion
        ? publishedRunLabel({
            workflowMode: state.workflowMode,
            publishedVersion: state.publishedVersion,
          })
        : "Run published version",
      detail: hasPublishedVersion
        ? "Runs the published version; draft edits are not included"
        : NOTHING_PUBLISHED_LABEL,
      keywords: "Run published version live test execute start trigger",
      disabled: isPublishedRunDisabled(state),
      execute: callbacks.runPublished,
    },
    ...(state.currentWorkflowId
      ? [
          {
            id: "mode" as const,
            group: "workflow" as const,
            label: `Set published mode to ${otherMode === "live" ? "Live" : "Test"}`,
            keywords: `Set published mode live test recipients ${otherMode}`,
            disabled: state.isSaving || state.isGenerating,
            execute: () => callbacks.switchMode(otherMode),
          },
        ]
      : []),
    {
      id: "show-runs",
      group: "workflow",
      label: "Go to run history",
      keywords: "Go to run history runs executions activity",
      disabled: !state.canViewRuns,
      execute: callbacks.showRuns,
    },
    {
      id: "show-changes",
      group: "workflow",
      label: "Go to version history",
      keywords: "Go to version history changes versions published compare",
      disabled: !state.canViewChanges,
      execute: callbacks.showChanges,
    },
    {
      id: "publish",
      group: "workflow",
      label: "Publish workflow",
      keywords: "Publish workflow version release",
      disabled: !state.canPublish,
      execute: callbacks.publish,
    },
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
    {
      id: "fit-view",
      group: "canvas",
      label: "Fit view",
      keywords: "Fit view zoom canvas",
      hint: shortcuts.fitView,
      disabled: false,
      execute: callbacks.fitView,
    },
    {
      id: "copy-selection",
      group: "canvas",
      label: "Copy selection",
      keywords: "Copy selection nodes steps",
      hint: shortcuts.copy,
      disabled: !state.canCopySelection,
      execute: callbacks.copySelection,
    },
    {
      id: "paste",
      group: "canvas",
      label: "Paste",
      keywords: "Paste selection nodes steps",
      hint: shortcuts.paste,
      disabled: !state.canPaste,
      execute: callbacks.pasteSelection,
    },
    {
      id: "duplicate-selection",
      group: "canvas",
      label: "Duplicate selection",
      keywords: "Duplicate selection copy nodes steps",
      hint: shortcuts.duplicate,
      disabled: !state.canCopySelection,
      execute: callbacks.duplicateSelection,
    },
    {
      id: "group-selection",
      group: "canvas",
      label: "Group selection",
      keywords: "Group selection frame nodes steps",
      hint: shortcuts.group,
      disabled: !state.canGroupSelection,
      execute: callbacks.groupSelection,
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
    case "save":
      return <Save className={className} />;
    case "run-draft":
      return <Play className={className} />;
    case "run-published":
      return <CirclePlay className={className} />;
    case "mode":
      return <ArrowLeftRight className={className} />;
    case "show-runs":
    case "show-changes":
      return <History className={className} />;
    case "publish":
      return <Upload className={className} />;
    case "undo":
      return <Undo2 className={className} />;
    case "redo":
      return <Redo2 className={className} />;
    case "reflow":
      return <RefreshCcw className={className} />;
    case "fit-view":
      return <Maximize2 className={className} />;
    case "copy-selection":
      return <Copy className={className} />;
    case "paste":
      return <ClipboardPaste className={className} />;
    case "duplicate-selection":
      return <CopyPlus className={className} />;
    case "group-selection":
      return <Group className={className} />;
    default:
      return null;
  }
}
