import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useReactFlow } from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Check,
  ChevronDown,
  Copy,
  Loader2,
  Play,
  Plus,
  Redo2,
  Save,
  Settings2,
  Trash2,
  Undo2,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { getClientLogger } from "#src/lib/logger";
import { Panel } from "#src/components/flow-elements/panel";
import { useDeleteWorkflow } from "#src/hooks/use-delete-workflow";
import { useDomEvent } from "#src/hooks/effects";
import { ConfigurationOverlay } from "#src/components/overlays/configuration-overlay";
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { WorkflowIssuesOverlay } from "#src/components/overlays/workflow-issues-overlay";
import { Button } from "#src/components/ui/button";
import { ButtonGroup } from "#src/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import { WorkflowIcon } from "#src/components/ui/workflow-icon";
import { CreateWorkflowDialog } from "#src/components/workflow/create-workflow-dialog";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/components/workflow/workflow-node-dimensions";
import { UserMenu } from "#src/components/workflows/user-menu";
import type { WorkflowExecuteResult } from "#src/lib/rpc-client";
import type { WorkflowExecutionIgnoredReason } from "@rova/shared/lifecycle/execution-contracts";
import {
  integrationsQueryOptions,
  orpcQuery,
  refreshRunHistory,
  refreshWorkflowList,
  workflowListQueryOptions,
} from "#src/lib/rpc-query";
import {
  addNodeAtom,
  canRedoAtom,
  canUndoAtom,
  clearGraphSelectionAtom,
  clearWorkflowAtom,
  deleteEdgeAtom,
  deleteNodeAtom,
  edgesAtom,
  nodesAtom,
  redoAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
  undoAtom,
  updateNodeDataAtom,
} from "#src/lib/workflow-graph-store";
import {
  createWorkflowAtom,
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
  currentWorkflowNameAtom,
  hasUnsavedChangesAtom,
  isSavingAtom,
  isWorkflowOwnerAtom,
  saveWorkflowAtom,
  setWorkflowModeAtom,
  workflowNameErrorAtom,
} from "#src/lib/workflow-save-store";
import {
  isExecutingAtom,
  isGeneratingAtom,
  isTransitioningFromHomepageAtom,
  propertiesPanelActiveTabAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";
import type { WorkflowEdge, WorkflowNode } from "@rova/shared/graph/types";
import { getExtensionCatalog } from "#src/lib/extensions";
import { findAction, findIntegration } from "@rova/shared/extensions/catalog";
import { flattenConfigFields } from "@rova/shared/plugins/action-fields";
import {
  getMissingRequiredFieldsForNodes,
  type MissingRequiredFieldInfo,
} from "@rova/shared/actions/action-config-validation";
import { findTemplateTokens } from "@rova/shared/graph/node-references";

// The `satisfies` is the exhaustiveness check: a reason added to the shared
// union fails to compile here until it has user-facing copy.
const logger = getClientLogger("workflow", "toolbar");

const IGNORED_REASON_MESSAGES = {
  workflow_paused: "Workflow is paused and cannot start new runs.",
  concurrency_first_wins:
    "A run for this entity is already going, and this workflow keeps the first one.",
  entity_value_missing:
    "This payload carries nothing at the workflow's Correlation Path, and its Concurrency needs an entity to compare.",
  manual_start_not_allowed:
    "This workflow does not list manual runs as a start source.",
} satisfies Record<WorkflowExecutionIgnoredReason, string>;

// Helper functions to reduce complexity
function updateNodesStatus(
  nodes: WorkflowNode[],
  updateNodeData: (update: {
    id: string;
    data: { status?: "idle" | "running" | "success" | "error" | "cancelled" };
  }) => void,
  status: "idle" | "running" | "success" | "error" | "cancelled"
) {
  for (const node of nodes) {
    updateNodeData({ id: node.id, data: { status } });
  }
}

type MissingIntegrationInfo = {
  integrationType: string;
  integrationLabel: string;
  nodeNames: string[];
};

type WorkflowToolbarProps = {
  workflowId?: string;
};

// Type for broken template reference info
type BrokenTemplateReferenceInfo = {
  nodeId: string;
  nodeLabel: string;
  brokenReferences: Array<{
    fieldKey: string;
    fieldLabel: string;
    referencedNodeId: string;
    displayText: string;
  }>;
};

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

// Extract template variables from a string and check if they reference existing nodes
function extractTemplateReferences(
  value: unknown
): Array<{ nodeId: string; displayText: string }> {
  if (typeof value !== "string") {
    return [];
  }

  return findTemplateTokens(value).map((token) => ({
    nodeId: token.nodeId,
    // What the author sees in the token, label and field path together.
    displayText: token.fieldPath
      ? `${token.nodeLabel}.${token.fieldPath}`
      : token.nodeLabel,
  }));
}

// Recursively extract all template references from a config object
function extractAllTemplateReferences(
  config: Record<string, unknown>,
  prefix = ""
): Array<{ field: string; nodeId: string; displayText: string }> {
  const results: Array<{ field: string; nodeId: string; displayText: string }> =
    [];

  for (const [key, value] of Object.entries(config)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "string") {
      const refs = extractTemplateReferences(value);
      for (const ref of refs) {
        results.push({ field: fieldPath, ...ref });
      }
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      // A copy carries the keyed value into the recursion, which walks config
      // one level at a time.
      const nested: Record<string, unknown> = { ...value };
      results.push(...extractAllTemplateReferences(nested, fieldPath));
    }
  }

  return results;
}

// Get broken template references for workflow nodes
function getBrokenTemplateReferences(
  nodes: WorkflowNode[]
): BrokenTemplateReferenceInfo[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const brokenByNode: BrokenTemplateReferenceInfo[] = [];

  for (const node of nodes) {
    // Skip disabled nodes
    if (node.data.enabled === false) {
      continue;
    }

    const config = node.data.config;
    if (!config || typeof config !== "object") {
      continue;
    }

    const allRefs = extractAllTemplateReferences(config);
    const brokenRefs = allRefs.filter((ref) => !nodeIds.has(ref.nodeId));

    if (brokenRefs.length > 0) {
      // Get action for label lookups
      const actionType = readConfigString(config, "actionType");
      const action = actionType
        ? findAction(getExtensionCatalog(), actionType)
        : undefined;
      const flatFields = action ? flattenConfigFields(action.configFields) : [];

      brokenByNode.push({
        nodeId: node.id,
        nodeLabel: node.data.label || action?.label || "Unnamed Step",
        brokenReferences: brokenRefs.map((ref) => {
          // Look up human-readable field label
          const configField = flatFields.find((f) => f.key === ref.field);
          return {
            fieldKey: ref.field,
            fieldLabel: configField?.label || ref.field,
            referencedNodeId: ref.nodeId,
            displayText: ref.displayText,
          };
        }),
      });
    }
  }

  return brokenByNode;
}

// Get missing required fields for workflow nodes
function getMissingRequiredFields(
  nodes: WorkflowNode[]
): MissingRequiredFieldInfo[] {
  return getMissingRequiredFieldsForNodes({
    nodes,
    resolveActionByType: (actionType) =>
      findAction(getExtensionCatalog(), actionType),
  });
}

// Which integrations a graph needs a connection for and does not have. The
// catalog answers both halves: which integration each action belongs to, and what
// that integration goes by.
function getMissingIntegrations(
  nodes: WorkflowNode[],
  userIntegrations: Array<{ id: string; type: string }>
): MissingIntegrationInfo[] {
  const userIntegrationIds = new Set(userIntegrations.map((i) => i.id));
  const missingByType = new Map<string, string[]>();

  for (const node of nodes) {
    // Skip disabled nodes
    if (node.data.enabled === false) {
      continue;
    }

    const actionType = readConfigString(node.data.config, "actionType");
    if (!actionType) {
      continue;
    }

    // The catalog says which integration an action needs.
    const action = findAction(getExtensionCatalog(), actionType);
    const requiredIntegrationType = action?.integration;

    if (!requiredIntegrationType) {
      continue;
    }

    // Check if this node has a valid integrationId configured
    // The integration must exist (not just be configured)
    const configuredIntegrationId = readConfigString(
      node.data.config,
      "integrationId"
    );
    const hasValidIntegration =
      configuredIntegrationId &&
      userIntegrationIds.has(configuredIntegrationId);
    if (hasValidIntegration) {
      continue;
    }

    const existing = missingByType.get(requiredIntegrationType) || [];
    // The node's own label, or the action's if it was never renamed.
    existing.push(node.data.label || action?.label || actionType);
    missingByType.set(requiredIntegrationType, existing);
  }

  return Array.from(missingByType.entries()).map(
    ([integrationType, nodeNames]) => ({
      integrationType,
      integrationLabel:
        findIntegration(getExtensionCatalog(), integrationType)?.label ||
        integrationType,
      nodeNames,
    })
  );
}

type ExecuteWorkflowRunParams = {
  /** The run mutation, with its variables already bound by the caller. */
  runWorkflow: () => Promise<WorkflowExecuteResult>;
  nodes: WorkflowNode[];
  updateNodeData: (update: {
    id: string;
    data: { status?: "idle" | "running" | "success" | "error" | "cancelled" };
  }) => void;
  setIsExecuting: (value: boolean) => void;
  setSelectedExecutionId: (value: string | null) => void;
};

async function executeWorkflowRun({
  runWorkflow,
  nodes,
  updateNodeData,
  setIsExecuting,
  setSelectedExecutionId,
}: ExecuteWorkflowRunParams) {
  // Set all nodes to idle first
  updateNodesStatus(nodes, updateNodeData, "idle");

  // Immediately set the Lifecycle Node to running for instant visual feedback
  for (const node of nodes) {
    if (node.data.type === "lifecycle") {
      updateNodeData({ id: node.id, data: { status: "running" } });
    }
  }

  try {
    const result = await runWorkflow();

    if (result.status !== "running" || !result.executionId) {
      toast.message(
        result.status === "ignored"
          ? IGNORED_REASON_MESSAGES[result.reason]
          : "Execution completed without starting a new run."
      );

      setSelectedExecutionId(null);
      setIsExecuting(false);
      updateNodesStatus(nodes, updateNodeData, "idle");
      return;
    }

    if (
      typeof result.supersededExecutions === "number" &&
      result.supersededExecutions > 0
    ) {
      const failed = Array.isArray(result.failedToSupersede)
        ? result.failedToSupersede.length
        : 0;
      const superseded = `Superseded ${result.supersededExecutions} run${result.supersededExecutions === 1 ? "" : "s"} for this entity and started a new one.`;

      if (failed > 0) {
        // A run the engine could not signal keeps going against the entity the
        // new one is now working on, which is the duplicate work newest-wins
        // exists to prevent. It reads as routine in the same tone as the success.
        toast.error(
          `${superseded} ${failed} could not be signalled and may still be running. Cancel them from the Runs panel.`
        );
      } else {
        toast.success(superseded);
      }
    }

    // Select the new execution
    setSelectedExecutionId(result.executionId);
  } catch (error) {
    // The mutation cache has already toasted the message. What is left is the
    // canvas, which still shows the Lifecycle Node running.
    logger.error("Failed to execute the workflow", { error });
    updateNodesStatus(nodes, updateNodeData, "error");
    setIsExecuting(false);
  }
}

// Hook for workflow handlers
type WorkflowHandlerParams = {
  currentWorkflowId: string | null;
  workflowName: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  updateNodeData: (update: {
    id: string;
    data: { status?: "idle" | "running" | "success" | "error" | "cancelled" };
  }) => void;
  isExecuting: boolean;
  setIsExecuting: (value: boolean) => void;
  setCurrentWorkflowName: (name: string) => void;
  setWorkflowNameError: (message: string | null) => void;
  setIsTransitioningFromHomepage: (value: boolean) => void;
  setActiveTab: (value: string) => void;
  setSelectedNodeId: (id: string | null) => void;
  setSelectedExecutionId: (id: string | null) => void;
  userIntegrations: Array<{ id: string; type: string }>;
};

function useWorkflowHandlers({
  currentWorkflowId,
  workflowName,
  nodes,
  edges,
  updateNodeData,
  isExecuting,
  setIsExecuting,
  setCurrentWorkflowName,
  setWorkflowNameError,
  setIsTransitioningFromHomepage,
  setActiveTab,
  setSelectedNodeId,
  setSelectedExecutionId,
  userIntegrations,
}: WorkflowHandlerParams) {
  const { open: openOverlay } = useOverlay();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const clearGraphSelection = useSetAtom(clearGraphSelectionAtom);
  const saveWorkflow = useSetAtom(saveWorkflowAtom);
  const createWorkflow = useSetAtom(createWorkflowAtom);
  // No errorMessage: a rejected run carries a server message worth reading, and
  // the mutation cache falls back to it. Every other outcome arrives as a
  // successful response with a status on it, which executeWorkflowRun reads.
  const runWorkflow = useMutation(
    orpcQuery.workflow.execute.mutationOptions({
      // A started run belongs in both run lists, and the dashboard's is the one
      // nobody is looking at when this fires.
      onSuccess: () => refreshRunHistory(queryClient),
    })
  );

  const handleSave = async () => {
    // The `add` node is a placeholder, so a canvas holding only one has nothing
    // worth saving. The save itself strips it; this is the emptiness check.
    if (!nodes.some((node) => node.type !== "add")) {
      setWorkflowNameError("Add at least one step before saving.");
      return;
    }

    const trimmedWorkflowName = workflowName.trim();
    if (!trimmedWorkflowName) {
      setWorkflowNameError("Workflow name is required.");
      return;
    }

    // The save queue drives the saving indicator, so there is nothing to
    // bracket here — it already covers autosaves this handler never sees.
    if (currentWorkflowId) {
      const outcome = await saveWorkflow(
        { name: trimmedWorkflowName, nodes, edges },
        { immediate: true }
      );

      if (outcome && !outcome.ok) {
        setWorkflowNameError(
          outcome.error.message || "Failed to save workflow. Please try again."
        );
        return;
      }

      setCurrentWorkflowName(trimmedWorkflowName);
      setWorkflowNameError(null);
      return;
    }

    // Creating adopts the new workflow's identity inside the save store.
    const outcome = await createWorkflow({
      name: trimmedWorkflowName,
      nodes,
      edges,
    });

    if (!outcome.ok) {
      setWorkflowNameError(
        outcome.error.message || "Failed to save workflow. Please try again."
      );
      return;
    }

    setIsTransitioningFromHomepage(true);
    await navigate({
      to: "/workflows/$workflowId",
      params: { workflowId: outcome.workflow.id },
      replace: true,
    });
  };

  const executeWorkflow = async () => {
    if (!currentWorkflowId) {
      toast.error("Please save the workflow before executing");
      return;
    }

    // Switch to Runs tab when starting a run
    setActiveTab("runs");

    // Deselect all nodes and edges
    clearGraphSelection();
    setSelectedNodeId(null);

    setIsExecuting(true);
    await executeWorkflowRun({
      runWorkflow: () =>
        runWorkflow.mutateAsync({ workflowId: currentWorkflowId, input: {} }),
      nodes,
      updateNodeData,
      setIsExecuting,
      setSelectedExecutionId,
    });
    // Don't set executing to false here - let polling handle it
  };

  const handleGoToStep = (nodeId: string, fieldKey?: string) => {
    setSelectedNodeId(nodeId);
    setActiveTab("properties");

    // Focus on the specific field after a short delay to allow the panel to render
    if (fieldKey) {
      setTimeout(() => {
        const element = document.getElementById(fieldKey);
        if (element) {
          element.focus();
          element.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 100);
    }
  };

  const handleExecute = async () => {
    // Guard against concurrent executions
    if (isExecuting) {
      return;
    }
    // Collect all workflow issues at once
    const brokenRefs = getBrokenTemplateReferences(nodes);
    const missingFields = getMissingRequiredFields(nodes);
    const missingIntegrations = getMissingIntegrations(nodes, userIntegrations);
    const hasBlockingIssues =
      missingFields.length > 0 || missingIntegrations.length > 0;

    // If there are any issues, show the workflow issues overlay
    if (
      brokenRefs.length > 0 ||
      missingFields.length > 0 ||
      missingIntegrations.length > 0
    ) {
      openOverlay(WorkflowIssuesOverlay, {
        issues: {
          brokenReferences: brokenRefs,
          missingRequiredFields: missingFields,
          missingIntegrations,
        },
        onGoToStep: handleGoToStep,
        onRunAnyway: hasBlockingIssues ? undefined : () => executeWorkflow(),
        allowRunAnyway: !hasBlockingIssues,
      });
      return;
    }

    await executeWorkflow();
  };

  return {
    handleSave,
    handleExecute,
  };
}

// Hook for workflow state management
function useWorkflowState() {
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const [isExecuting, setIsExecuting] = useAtom(isExecutingAtom);
  const [isGenerating] = useAtom(isGeneratingAtom);
  const clearWorkflow = useSetAtom(clearWorkflowAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const [workflowName, setCurrentWorkflowName] = useAtom(
    currentWorkflowNameAtom
  );
  const [workflowMode, setCurrentWorkflowMode] = useAtom(
    currentWorkflowModeAtom
  );
  const setWorkflowNameError = useSetAtom(workflowNameErrorAtom);
  const setIsTransitioningFromHomepage = useSetAtom(
    isTransitioningFromHomepageAtom
  );
  const isOwner = useAtomValue(isWorkflowOwnerAtom);
  const isSaving = useAtomValue(isSavingAtom);
  const hasUnsavedChanges = useAtomValue(hasUnsavedChangesAtom);
  const undo = useSetAtom(undoAtom);
  const redo = useSetAtom(redoAtom);
  const addNode = useSetAtom(addNodeAtom);
  const [canUndo] = useAtom(canUndoAtom);
  const [canRedo] = useAtom(canRedoAtom);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const setSelectedNodeId = useSetAtom(selectedNodeAtom);
  const setSelectedExecutionId = useSetAtom(selectedExecutionIdAtom);
  const { data: userIntegrations = [] } = useQuery(integrationsQueryOptions());

  const { data: allWorkflows = [] } = useQuery(workflowListQueryOptions());

  return {
    nodes,
    edges,
    isExecuting,
    setIsExecuting,
    isGenerating,
    clearWorkflow,
    updateNodeData,
    currentWorkflowId,
    workflowName,
    workflowMode,
    setCurrentWorkflowName,
    setCurrentWorkflowMode,
    setWorkflowNameError,
    setIsTransitioningFromHomepage,
    isOwner,
    isSaving,
    hasUnsavedChanges,
    undo,
    redo,
    addNode,
    canUndo,
    canRedo,
    allWorkflows,
    setActiveTab,
    setSelectedNodeId,
    setSelectedExecutionId,
    userIntegrations,
  };
}

// Hook for workflow actions
function useWorkflowActions(state: ReturnType<typeof useWorkflowState>) {
  const { open: openOverlay } = useOverlay();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const deleteWorkflow = useDeleteWorkflow();
  const setWorkflowMode = useSetAtom(setWorkflowModeAtom);
  const {
    currentWorkflowId,
    workflowName,
    workflowMode,
    setCurrentWorkflowName,
    setCurrentWorkflowMode,
    setWorkflowNameError,
    setIsTransitioningFromHomepage,
    nodes,
    edges,
    updateNodeData,
    isExecuting,
    setIsExecuting,
    clearWorkflow,
    setActiveTab,
    setSelectedNodeId,
    setSelectedExecutionId,
    userIntegrations,
  } = state;

  const { handleSave, handleExecute } = useWorkflowHandlers({
    currentWorkflowId,
    workflowName,
    nodes,
    edges,
    updateNodeData,
    isExecuting,
    setIsExecuting,
    setCurrentWorkflowName,
    setWorkflowNameError,
    setIsTransitioningFromHomepage,
    setActiveTab,
    setSelectedNodeId,
    setSelectedExecutionId,
    userIntegrations,
  });

  // Cmd+Enter runs the workflow. The listener lives here, beside handleExecute,
  // so the shortcut and the Run button are the same call rather than a store
  // round trip for something one function call away.
  //
  // Capture phase, because a focused node in the canvas would otherwise get the
  // keystroke first.
  const handleRunShortcut = useCallback(
    (event: KeyboardEvent) => {
      if (!((event.metaKey || event.ctrlKey) && event.key === "Enter")) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && isTextEntry(target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void handleExecute();
    },
    [handleExecute]
  );

  useDomEvent(document, "keydown", handleRunShortcut, { capture: true });

  const handleClearWorkflow = () => {
    openOverlay(ConfirmOverlay, {
      title: "Clear Workflow",
      message:
        "Remove every step and connection? The Lifecycle Node is kept, and this saves right away.",
      confirmLabel: "Clear Workflow",
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: () => {
        clearWorkflow();
      },
    });
  };

  const handleDeleteWorkflow = () => {
    openOverlay(ConfirmOverlay, {
      title: "Delete Workflow",
      message: `Are you sure you want to delete "${workflowName}"? This will permanently delete the workflow. This cannot be undone.`,
      confirmLabel: "Delete Workflow",
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: () => {
        if (!currentWorkflowId) {
          return;
        }
        deleteWorkflow.mutate({ workflowId: currentWorkflowId });
      },
    });
  };

  // The switcher dropdown opening is a good moment to re-read the list, and a
  // create or a delete elsewhere invalidates the same key.
  const loadWorkflows = () => refreshWorkflowList(queryClient);

  const duplicateWorkflow = useMutation(
    orpcQuery.workflow.duplicate.mutationOptions({
      onSuccess: async (payload) => {
        toast.success("Workflow duplicated successfully");
        await loadWorkflows();
        await navigate({
          to: "/workflows/$workflowId",
          params: { workflowId: payload.id },
        });
      },
      meta: { errorMessage: "Failed to duplicate workflow. Please try again." },
    })
  );

  const handleDuplicate = () => {
    if (!currentWorkflowId) {
      return;
    }
    duplicateWorkflow.mutate({ workflowId: currentWorkflowId });
  };

  const handleSetWorkflowMode = async (mode: "live" | "test") => {
    if (!currentWorkflowId || workflowMode === mode) {
      return;
    }

    const outcome = await setWorkflowMode(mode);
    if (!outcome?.ok) {
      toast.error("Failed to update workflow mode");
      return;
    }

    // No loadWorkflows: this went through the save queue, which marks the list
    // stale on every write it lands.
    setCurrentWorkflowMode(outcome.workflow.mode);
    toast.success(
      mode === "test"
        ? "Workflow set to Test mode"
        : "Workflow set to Live mode"
    );
  };

  return {
    handleSave,
    handleExecute,
    handleClearWorkflow,
    handleDeleteWorkflow,
    loadWorkflows,
    handleDuplicate,
    isDuplicating: duplicateWorkflow.isPending,
    handleSetWorkflowMode,
  };
}

/** Typing somewhere should not be interrupted by a workflow-level shortcut. */
function isTextEntry(target: HTMLElement): boolean {
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

// Toolbar Actions Component - handles add step, undo/redo, save, and run buttons
function ToolbarActions({
  workflowId,
  state,
  actions,
}: {
  workflowId?: string;
  state: ReturnType<typeof useWorkflowState>;
  actions: ReturnType<typeof useWorkflowActions>;
}) {
  const { open: openOverlay, push } = useOverlay();
  const [selectedNodeId] = useAtom(selectedNodeAtom);
  const [selectedEdgeId] = useAtom(selectedEdgeAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const deleteNode = useSetAtom(deleteNodeAtom);
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const { screenToFlowPosition } = useReactFlow();

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const hasSelection = selectedNode || selectedEdge;

  // For non-owners viewing public workflows, don't show toolbar actions.
  if (workflowId && !state.isOwner) {
    return null;
  }

  const handleDeleteConfirm = () => {
    const isNode = Boolean(selectedNodeId);
    const itemType = isNode ? "Node" : "Connection";

    push(ConfirmOverlay, {
      title: `Delete ${itemType}`,
      message: `Are you sure you want to delete this ${itemType.toLowerCase()}? This action cannot be undone.`,
      confirmLabel: "Delete",
      confirmVariant: "destructive" as const,
      onConfirm: () => {
        if (selectedNodeId) {
          deleteNode(selectedNodeId);
        } else if (selectedEdgeId) {
          deleteEdge(selectedEdgeId);
        }
      },
    });
  };

  const handleAddStep = () => {
    // Get the ReactFlow wrapper (the visible canvas container)
    const flowWrapper = document.querySelector(".react-flow");
    if (!flowWrapper) {
      return;
    }

    const rect = flowWrapper.getBoundingClientRect();
    // Calculate center in absolute screen coordinates
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Convert to flow coordinates
    const position = screenToFlowPosition({ x: centerX, y: centerY });

    // Adjust for node dimensions to center it properly
    position.x -= WORKFLOW_NODE_WIDTH / 2;
    position.y -= WORKFLOW_NODE_HEIGHT / 2;

    // Check if there's already a node at this position
    const offset = 20; // Offset distance in pixels
    const threshold = 20; // How close nodes need to be to be considered overlapping

    const finalPosition = { ...position };
    let hasOverlap = true;
    let attempts = 0;
    const maxAttempts = 20; // Prevent infinite loop

    while (hasOverlap && attempts < maxAttempts) {
      hasOverlap = state.nodes.some((node) => {
        const dx = Math.abs(node.position.x - finalPosition.x);
        const dy = Math.abs(node.position.y - finalPosition.y);
        return dx < threshold && dy < threshold;
      });

      if (hasOverlap) {
        // Offset diagonally down-right
        finalPosition.x += offset;
        finalPosition.y += offset;
        attempts += 1;
      }
    }

    // Create new action node
    const newNode: WorkflowNode = {
      id: nanoid(),
      type: "action",
      position: finalPosition,
      data: {
        label: "",
        description: "",
        type: "action",
        config: {},
        status: "idle",
      },
    };

    state.addNode(newNode);
    state.setSelectedNodeId(newNode.id);
    state.setActiveTab("properties");
  };

  return (
    <>
      {/* Add Step - Mobile Vertical */}
      <ButtonGroup className="flex lg:hidden" orientation="vertical">
        <Button
          className="border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
          disabled={state.isGenerating}
          onClick={handleAddStep}
          size="icon"
          title="Add Step"
          variant="secondary"
        >
          <Plus className="size-4" />
        </Button>
      </ButtonGroup>

      {/* Properties - Mobile Vertical (always visible) */}
      <ButtonGroup className="flex lg:hidden" orientation="vertical">
        <Button
          className="border hover:bg-secondary dark:hover:bg-secondary"
          onClick={() => openOverlay(ConfigurationOverlay, {})}
          size="icon"
          title="Configuration"
          variant="secondary"
        >
          <Settings2 className="size-4" />
        </Button>
        {/* Delete - Show when node or edge is selected */}
        {hasSelection && (
          <Button
            className="border hover:bg-secondary dark:hover:bg-secondary"
            onClick={handleDeleteConfirm}
            size="icon"
            title="Delete"
            variant="secondary"
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </ButtonGroup>

      {/* Add Step - Desktop Horizontal */}
      <ButtonGroup className="hidden lg:flex" orientation="horizontal">
        <Button
          className="border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
          disabled={state.isGenerating}
          onClick={handleAddStep}
          size="icon"
          title="Add Step"
          variant="secondary"
        >
          <Plus className="size-4" />
        </Button>
      </ButtonGroup>

      {/* Undo/Redo - Mobile Vertical */}
      <ButtonGroup className="flex lg:hidden" orientation="vertical">
        <Button
          className="border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
          disabled={!state.canUndo || state.isGenerating}
          onClick={() => state.undo()}
          size="icon"
          title="Undo"
          variant="secondary"
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          className="border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
          disabled={!state.canRedo || state.isGenerating}
          onClick={() => state.redo()}
          size="icon"
          title="Redo"
          variant="secondary"
        >
          <Redo2 className="size-4" />
        </Button>
      </ButtonGroup>

      {/* Undo/Redo - Desktop Horizontal */}
      <ButtonGroup className="hidden lg:flex" orientation="horizontal">
        <Button
          className="border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
          disabled={!state.canUndo || state.isGenerating}
          onClick={() => state.undo()}
          size="icon"
          title="Undo"
          variant="secondary"
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          className="border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
          disabled={!state.canRedo || state.isGenerating}
          onClick={() => state.redo()}
          size="icon"
          title="Redo"
          variant="secondary"
        >
          <Redo2 className="size-4" />
        </Button>
      </ButtonGroup>

      {/* Save - Mobile Vertical */}
      <ButtonGroup className="flex lg:hidden" orientation="vertical">
        <SaveButton handleSave={actions.handleSave} state={state} />
      </ButtonGroup>

      {/* Save - Desktop Horizontal */}
      <ButtonGroup className="hidden lg:flex" orientation="horizontal">
        <SaveButton handleSave={actions.handleSave} state={state} />
      </ButtonGroup>

      <RunButtonGroup actions={actions} state={state} />
      {workflowId && (
        <ButtonGroup className="flex" orientation="horizontal">
          <Button
            className="border"
            disabled={state.isSaving || state.isGenerating}
            onClick={() => actions.handleSetWorkflowMode("live")}
            size="sm"
            variant={state.workflowMode === "live" ? "secondary" : "outline"}
          >
            Live
          </Button>
          <Button
            className="border"
            disabled={state.isSaving || state.isGenerating}
            onClick={() => actions.handleSetWorkflowMode("test")}
            size="sm"
            variant={state.workflowMode === "test" ? "secondary" : "outline"}
          >
            Test
          </Button>
        </ButtonGroup>
      )}
    </>
  );
}

// Save Button Component
function SaveButton({
  state,
  handleSave,
}: {
  state: ReturnType<typeof useWorkflowState>;
  handleSave: () => Promise<void>;
}) {
  const hasRealNodes = state.nodes.some((node) => node.type !== "add");

  return (
    <Button
      className="relative border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
      disabled={!hasRealNodes || state.isGenerating || state.isSaving}
      onClick={handleSave}
      size="icon"
      title={state.isSaving ? "Saving..." : "Save workflow"}
      variant="secondary"
    >
      {state.isSaving ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Save className="size-4" />
      )}
      {state.hasUnsavedChanges && !state.isSaving && (
        <div className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary" />
      )}
    </Button>
  );
}

// Run Button Group Component
function RunButtonGroup({
  state,
  actions,
}: {
  state: ReturnType<typeof useWorkflowState>;
  actions: ReturnType<typeof useWorkflowActions>;
}) {
  const isDisabled =
    state.isExecuting ||
    state.nodes.length === 0 ||
    state.isGenerating ||
    !state.currentWorkflowId;

  return (
    <ButtonGroup className="flex" orientation="horizontal">
      <Button
        className="border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
        disabled={isDisabled}
        onClick={() => actions.handleExecute()}
        size="icon"
        title="Run Workflow"
        variant="secondary"
      >
        {state.isExecuting ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Play className="size-4" />
        )}
      </Button>
    </ButtonGroup>
  );
}

// Duplicate button for read-only/public workflow views
function DuplicateButton({
  isDuplicating,
  onDuplicate,
}: {
  isDuplicating: boolean;
  onDuplicate: () => void;
}) {
  return (
    <Button
      className="h-9 border hover:bg-secondary dark:hover:bg-secondary"
      disabled={isDuplicating}
      onClick={onDuplicate}
      size="sm"
      title="Duplicate to your workflows"
      variant="secondary"
    >
      {isDuplicating ? (
        <Loader2 className="mr-2 size-4 animate-spin" />
      ) : (
        <Copy className="mr-2 size-4" />
      )}
      Duplicate
    </Button>
  );
}

// Workflow Menu Component
function WorkflowMenuComponent({
  workflowId,
  state,
  actions,
}: {
  workflowId?: string;
  state: ReturnType<typeof useWorkflowState>;
  actions: ReturnType<typeof useWorkflowActions>;
}) {
  const navigate = useNavigate();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  // Bumped on every open so the dialog remounts and re-suggests a name. It stays
  // mounted while closing, because that is what its exit animation needs.
  const [createDialogSession, setCreateDialogSession] = useState(0);

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex h-9 max-w-[160px] items-center overflow-hidden rounded-md border bg-secondary text-secondary-foreground sm:max-w-none">
          <DropdownMenu
            onOpenChange={(open) => open && actions.loadWorkflows()}
          >
            <DropdownMenuTrigger className="flex h-full cursor-pointer items-center gap-2 px-3 font-medium text-sm transition-all hover:bg-secondary dark:hover:bg-secondary">
              <WorkflowIcon className="size-4 shrink-0" />
              <p className="truncate font-medium text-sm">
                {workflowId ? (
                  state.workflowName
                ) : (
                  <>
                    <span className="sm:hidden">Dashboard</span>
                    <span className="hidden sm:inline">Workflow Dashboard</span>
                  </>
                )}
              </p>
              <ChevronDown className="size-3 shrink-0 opacity-50" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuItem
                className="flex items-center justify-between"
                onClick={() => navigate({ to: "/" })}
              >
                Dashboard {!workflowId && <Check className="size-4 shrink-0" />}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex items-center gap-2"
                onClick={() => {
                  setCreateDialogSession((session) => session + 1);
                  setIsCreateDialogOpen(true);
                }}
              >
                <Plus className="size-4" />
                New Workflow...
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {state.allWorkflows.length === 0 ? (
                <DropdownMenuItem disabled>No workflows found</DropdownMenuItem>
              ) : (
                state.allWorkflows
                  .filter((w) => w.name !== "__current__")
                  .map((workflow) => (
                    <DropdownMenuItem
                      className="flex items-center justify-between"
                      key={workflow.id}
                      onClick={() =>
                        navigate({
                          to: "/workflows/$workflowId",
                          params: { workflowId: workflow.id },
                        })
                      }
                    >
                      <span className="truncate">{workflow.name}</span>
                      {workflow.id === state.currentWorkflowId && (
                        <Check className="size-4 shrink-0" />
                      )}
                    </DropdownMenuItem>
                  ))
              )}
              {workflowId && state.isOwner && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="flex items-center gap-2"
                    disabled={actions.isDuplicating}
                    onClick={actions.handleDuplicate}
                  >
                    {actions.isDuplicating ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                    Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="flex items-center gap-2 text-destructive focus:text-destructive"
                    onClick={actions.handleDeleteWorkflow}
                  >
                    <Trash2 className="size-4" />
                    Delete Workflow
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {workflowId && !state.isOwner && (
          <span className="text-muted-foreground text-xs uppercase lg:hidden">
            Read-only
          </span>
        )}
      </div>
      <CreateWorkflowDialog
        key={createDialogSession}
        existingWorkflowNames={state.allWorkflows.map(
          (workflow) => workflow.name
        )}
        onCreated={(createdWorkflowId) =>
          navigate({
            to: "/workflows/$workflowId",
            params: { workflowId: createdWorkflowId },
          })
        }
        onOpenChange={setIsCreateDialogOpen}
        open={isCreateDialogOpen}
      />
    </>
  );
}

export const WorkflowToolbar = ({ workflowId }: WorkflowToolbarProps) => {
  const state = useWorkflowState();
  const actions = useWorkflowActions(state);

  return (
    <>
      <Panel
        className="flex flex-col gap-2 rounded-none border-none bg-transparent p-0 lg:flex-row lg:items-center"
        position="top-left"
      >
        <div className="flex items-center gap-2">
          <WorkflowMenuComponent
            actions={actions}
            state={state}
            workflowId={workflowId}
          />
          {workflowId && state.workflowMode === "test" && (
            <span className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 font-semibold text-[10px] text-destructive uppercase">
              Test Mode
            </span>
          )}
          {workflowId && !state.isOwner && (
            <span className="hidden text-muted-foreground text-xs uppercase lg:inline">
              Read-only
            </span>
          )}
        </div>
      </Panel>

      <div className="pointer-events-auto absolute top-4 right-4 z-10">
        <div className="flex flex-col-reverse items-end gap-2 lg:flex-row lg:items-center">
          <ToolbarActions
            actions={actions}
            state={state}
            workflowId={workflowId}
          />
          <div className="flex items-center gap-2">
            {workflowId && !state.isOwner && (
              <DuplicateButton
                isDuplicating={actions.isDuplicating}
                onDuplicate={actions.handleDuplicate}
              />
            )}
            <UserMenu />
          </div>
        </div>
      </div>
      {workflowId && state.workflowMode === "test" && (
        <div className="pointer-events-none absolute right-4 bottom-4 z-10 max-w-xl rounded border border-destructive/30 bg-destructive/10 px-4 py-2 text-xs">
          <p className="font-semibold text-destructive uppercase tracking-wide">
            Test mode active
          </p>
          <p className="font-medium text-foreground">
            No real email or SMS is sent unless a node is configured to route to
            a test recipient.
          </p>
        </div>
      )}
    </>
  );
};
