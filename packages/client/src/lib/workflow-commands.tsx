import {
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
  publishedModeChoice,
  publishedRunLabel,
} from "#src/lib/workflow-run-labels";

export type WorkflowCommandId =
  | "add-step"
  | "save"
  | "run-draft"
  | "run-published"
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
  readonly detail?: string | undefined;
  readonly keywords: string;
  readonly hint?: string | undefined;
  /**
   * Whether running this command reaches real recipients. A surface that
   * highlights rows on its own must skip these, because a highlighted row plus
   * the Return key would send without anyone choosing to.
   */
  readonly consequential?: boolean | undefined;
  /**
   * Whether this command belongs to the command palette alone. The Actions menu
   * skips these, because the toolbar already offers them as their own control.
   */
  readonly paletteOnly?: boolean | undefined;
  readonly disabled: boolean;
  readonly execute: () => void;
};

type WorkflowCommandState = {
  readonly currentWorkflowId: string | null;
  readonly workflowMode: WorkflowMode;
  /** The published version's number, absent until the first publish. */
  readonly publishedVersion?: number | undefined;
  readonly isExecuting: boolean;
  readonly isPreflighting: boolean;
  readonly isGenerating: boolean;
  readonly hasNodes: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly canReflow: boolean;
  readonly canEdit: boolean;
  readonly canSave: boolean;
  readonly canRunDraft: boolean;
  readonly canRunPublished: boolean;
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
  readonly publication?:
    | {
        readonly isPublished: boolean;
        readonly hasUnpublishedChanges: boolean;
      }
    | undefined;
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
 * The state both run commands are gated on. One shape, so a surface offering
 * both commands checks them against the same facts.
 */
export type WorkflowRunEligibility = {
  readonly currentWorkflowId: string | null;
  readonly isExecuting: boolean;
  readonly isPreflighting: boolean;
  readonly isGenerating: boolean;
  readonly hasNodes: boolean;
  /** The published version's number, absent until the first publish. */
  readonly publishedVersion?: number | undefined;
};

/**
 * The conditions both run commands need: a saved workflow, and no run already
 * in flight from this editor. Canvas state is checked elsewhere, because a
 * published version is frozen and the canvas cannot affect it.
 */
function isRunUnavailable(state: WorkflowRunEligibility): boolean {
  return state.isExecuting || !state.currentWorkflowId;
}

/**
 * The gate for Run draft, which is where the canvas conditions live. An empty
 * canvas has no draft to run, a generating canvas is being rewritten, and the
 * issue preflight applies to this command alone.
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
 * The gate for the published run. Its only extra condition is that a version
 * exists. A published version is immutable, so canvas edits cannot disable it.
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
  const hasPublishedVersion = state.publishedVersion !== undefined;

  return [
    {
      id: "add-step",
      group: "steps",
      label: "Add step",
      keywords: "Add step node action new create insert",
      disabled: !state.canEdit || state.editingLocked,
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
      // A draft run always reaches test recipients, so the detail says so in
      // the words the Published mode menu uses for the same fact.
      detail: "Test recipients",
      keywords: "Run draft canvas execute test start trigger",
      hint: shortcuts.run,
      // The toolbar's run control offers this already; the palette is the
      // second way to reach it rather than a second copy in the same menu.
      paletteOnly: true,
      disabled: !state.canRunDraft || isDraftRunDisabled(state),
      execute: callbacks.runDraft,
    },
    {
      id: "run-published",
      group: "workflow",
      // The label names the version and the Published mode, which is what
      // distinguishes it from Run draft. Before the first publish the label
      // still names an action, because the palette lists this row flat beside
      // "Run draft" and a bare "Nothing published yet" would name none. The
      // reason goes in the detail line underneath.
      label: hasPublishedVersion
        ? publishedRunLabel({
            workflowMode: state.workflowMode,
            publishedVersion: state.publishedVersion,
          })
        : "Run published version",
      // Who the run reaches is the one fact the version number leaves out, and
      // the Published mode menu already owns the words for it.
      detail: hasPublishedVersion
        ? publishedModeChoice(state.workflowMode).description
        : NOTHING_PUBLISHED_LABEL,
      keywords: "Run published version live test execute start trigger",
      disabled: !state.canRunPublished || isPublishedRunDisabled(state),
      paletteOnly: true,
      // A live run is the only one that reaches real recipients, so the palette
      // requires an arrow key on this row before Return takes it.
      consequential: hasPublishedVersion && state.workflowMode === "live",
      execute: callbacks.runPublished,
    },
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
      disabled: !state.canEdit || !state.canUndo || state.editingLocked,
      execute: callbacks.undo,
    },
    {
      id: "redo",
      group: "workflow",
      label: "Redo",
      keywords: "Redo forward again",
      hint: shortcuts.redo,
      disabled: !state.canEdit || !state.canRedo || state.editingLocked,
      execute: callbacks.redo,
    },
    {
      id: "reflow",
      group: "workflow",
      label: "Tidy layout",
      keywords: "Tidy layout arrange align auto layout clean up",
      disabled: !state.canEdit || !state.canReflow,
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
