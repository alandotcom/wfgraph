import { useReactFlow } from "@xyflow/react";
import { useAtomValue, useSetAtom } from "jotai";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useReflowLayout } from "#src/components/workflow/use-reflow-layout";
import { useWorkflowComparisonActions } from "#src/components/workflow/use-workflow-comparison-actions";
import type { WorkflowToolbarActions } from "#src/components/workflow/workflow-toolbar-handlers";
import type { WorkflowToolbarState } from "#src/components/workflow/workflow-toolbar-state";
import { useWorkflowWorkspaceNavigation } from "#src/hooks/use-workflow-workspace-navigation";
import { viewportAnimationDuration } from "#src/lib/motion";
import { workflowFitViewOptions } from "./workflow-viewport";
import {
  currentPlatform,
  editorShortcutLabels,
  isApplePlatform,
} from "#src/lib/shortcut-label";
import {
  canvasEditingLockedAtom,
  copySelectionAtom,
  duplicateSelectionAtom,
  groupSelectionAtom,
  hasCopiedSelectionAtom,
  pasteCopiedSelectionAtom,
} from "#src/lib/workflow-graph-store";
import {
  isWorkflowPublishDisabled,
  workflowCommands,
} from "#src/lib/workflow-commands";
import { analyzeGroupableSelection } from "@wfgraph/shared/graph/node-group";

/** Build the command policy and handlers once for every command surface. */
export function useWorkflowCommands({
  state,
  actions,
  onAddStep,
}: {
  state: WorkflowToolbarState;
  actions: WorkflowToolbarActions;
  onAddStep: () => void;
}) {
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  const hasCopiedSelection = useAtomValue(hasCopiedSelectionAtom);
  const copySelection = useSetAtom(copySelectionAtom);
  const pasteSelection = useSetAtom(pasteCopiedSelectionAtom);
  const duplicateSelection = useSetAtom(duplicateSelectionAtom);
  const groupSelection = useSetAtom(groupSelectionAtom);
  const catalog = useExtensionCatalog();
  const { fitView } = useReactFlow();
  const { canReflow, reflow } = useReflowLayout();
  const comparisonActions = useWorkflowComparisonActions();
  const workspaceNavigation = useWorkflowWorkspaceNavigation(
    comparisonActions.openComparison
  );
  const shortcuts = useMemo(
    () => editorShortcutLabels(isApplePlatform(currentPlatform())),
    []
  );

  const selectedIds = new Set(
    state.nodes.filter((node) => node.selected).map((node) => node.id)
  );
  const hasNodes = state.nodes.some((node) => node.type !== "add");
  const hasCopyableSelection = state.nodes.some(
    (node) =>
      node.selected && node.data.type !== "lifecycle" && node.type !== "add"
  );
  const grouping = analyzeGroupableSelection(
    state.nodes,
    state.edges,
    selectedIds,
    catalog
  );

  return workflowCommands({
    state: {
      currentWorkflowId: state.currentWorkflowId,
      workflowMode: state.workflowMode,
      publishedVersion: state.publication?.publishedVersion,
      isExecuting: state.isExecuting,
      isPreflighting: actions.isPreflighting,
      isGenerating: state.isGenerating,
      hasNodes,
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      canReflow,
      canEdit: state.canUpdate,
      canSave:
        Boolean(state.currentWorkflowId) &&
        !state.isGenerating &&
        state.canUpdate,
      canRunDraft: state.canExecute && state.canUpdate,
      canRunPublished: state.canExecute && state.canReadVersionGraph,
      canViewRuns: Boolean(state.currentWorkflowId) && state.canReadRuns,
      canViewChanges:
        Boolean(state.currentWorkflowId) &&
        state.canReadVersionHistory &&
        Boolean(state.publication?.isPublished),
      canPublish:
        state.canPublish &&
        !isWorkflowPublishDisabled({
          editingLocked,
          isSaving: state.isSaving,
          isComparing: actions.isComparing,
          isPublishing: actions.isPublishing,
          isPreflighting: actions.isPreflighting,
          hasNodes,
          hasUnsavedChanges: state.hasUnsavedChanges,
          publication: state.publication,
        }),
      canCopySelection:
        state.canUpdate && hasCopyableSelection && !editingLocked,
      canPaste: state.canUpdate && hasCopiedSelection && !editingLocked,
      canGroupSelection: state.canUpdate && grouping.ok && !editingLocked,
      editingLocked,
    },
    shortcuts,
    callbacks: {
      addStep: onAddStep,
      save: () => void actions.handleSave(),
      runDraft: () => void actions.handleExecute("draft"),
      runPublished: () => void actions.handleExecute("published"),
      showRuns: workspaceNavigation.showRuns,
      showChanges: workspaceNavigation.showChanges,
      publish: actions.handlePublish,
      fitView: () =>
        void fitView(workflowFitViewOptions(viewportAnimationDuration())),
      copySelection: () => void copySelection(),
      pasteSelection: () => void pasteSelection(),
      duplicateSelection: () => void duplicateSelection(),
      groupSelection: () => void groupSelection({ catalog }),
      undo: state.undo,
      redo: state.redo,
      reflow,
    },
  });
}
