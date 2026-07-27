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
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Panel } from "@/components/flow-elements/panel";
import { ConfigurationOverlay } from "@/components/overlays/configuration-overlay";
import { ConfirmOverlay } from "@/components/overlays/confirm-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { WorkflowIssuesOverlay } from "@/components/overlays/workflow-issues-overlay";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkflowIcon } from "@/components/ui/workflow-icon";
import { CreateWorkflowDialog } from "@/components/workflow/create-workflow-dialog";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "@/components/workflow/workflow-node-dimensions";
import { UserMenu } from "@/components/workflows/user-menu";
import { integrationsAtom } from "@/lib/integrations-store";
import { api } from "@/lib/rpc-client";
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
} from "@/lib/workflow-graph-store";
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
} from "@/lib/workflow-save-store";
import {
  isExecutingAtom,
  isGeneratingAtom,
  isTransitioningFromHomepageAtom,
  propertiesPanelActiveTabAtom,
  selectedExecutionIdAtom,
  triggerExecuteAtom,
} from "@/lib/workflow-ui-store";
import type { WorkflowEdge, WorkflowNode } from "@/shared/workflow/types";
import {
  findActionById,
  flattenConfigFields,
  getIntegrationLabels,
} from "@/plugins/registry";
import {
  type IntegrationType,
  isIntegrationType,
} from "@/shared/types/integration";
import {
  getMissingRequiredFieldsForNodes,
  type MissingRequiredFieldInfo,
} from "@/shared/workflow/action-config-validation";
import { findTemplateTokens } from "@/shared/workflow/node-references";
import {
  SYSTEM_ACTION_INTEGRATIONS,
  SYSTEM_INTEGRATION_LABELS,
} from "@/shared/workflow/system-action-integrations";

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
  integrationType: IntegrationType;
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
      const action = actionType ? findActionById(actionType) : undefined;
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
    resolveActionByType: (actionType) => findActionById(actionType),
  });
}

// Get missing integrations for workflow nodes
// Uses the plugin registry to determine which integrations are required
// Also handles built-in actions that aren't in the plugin registry
function getMissingIntegrations(
  nodes: WorkflowNode[],
  userIntegrations: Array<{ id: string; type: IntegrationType }>
): MissingIntegrationInfo[] {
  const userIntegrationIds = new Set(userIntegrations.map((i) => i.id));
  const missingByType = new Map<IntegrationType, string[]>();
  const integrationLabels = getIntegrationLabels();

  for (const node of nodes) {
    // Skip disabled nodes
    if (node.data.enabled === false) {
      continue;
    }

    const actionType = readConfigString(node.data.config, "actionType");
    if (!actionType) {
      continue;
    }

    // Look up the integration type from the plugin registry first
    const action = findActionById(actionType);
    // Fall back to built-in action integrations for actions not in the registry
    const requiredIntegrationTypeRaw =
      action?.integration || SYSTEM_ACTION_INTEGRATIONS[actionType];

    if (
      !(
        requiredIntegrationTypeRaw &&
        isIntegrationType(requiredIntegrationTypeRaw)
      )
    ) {
      continue;
    }

    const requiredIntegrationType = requiredIntegrationTypeRaw;

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
    // Use human-readable label from registry if no custom label
    existing.push(node.data.label || action?.label || actionType);
    missingByType.set(requiredIntegrationType, existing);
  }

  return Array.from(missingByType.entries()).map(
    ([integrationType, nodeNames]) => ({
      integrationType,
      integrationLabel:
        integrationLabels[integrationType] ||
        SYSTEM_INTEGRATION_LABELS[integrationType] ||
        integrationType,
      nodeNames,
    })
  );
}

type ExecuteWorkflowRunParams = {
  workflowId: string;
  nodes: WorkflowNode[];
  updateNodeData: (update: {
    id: string;
    data: { status?: "idle" | "running" | "success" | "error" | "cancelled" };
  }) => void;
  setIsExecuting: (value: boolean) => void;
  setSelectedExecutionId: (value: string | null) => void;
};

async function executeWorkflowRun({
  workflowId,
  nodes,
  updateNodeData,
  setIsExecuting,
  setSelectedExecutionId,
}: ExecuteWorkflowRunParams) {
  // Set all nodes to idle first
  updateNodesStatus(nodes, updateNodeData, "idle");

  // Immediately set trigger nodes to running for instant visual feedback
  for (const node of nodes) {
    if (node.data.type === "trigger") {
      updateNodeData({ id: node.id, data: { status: "running" } });
    }
  }

  try {
    const result = await api.workflow.execute(workflowId, {});

    if (result.status !== "running" || !result.executionId) {
      if (result.status === "cancelled") {
        const cancelledExecutions =
          typeof result.cancelledExecutions === "number"
            ? result.cancelledExecutions
            : 0;
        toast.success(
          cancelledExecutions > 0
            ? `Cancelled ${cancelledExecutions} waiting run${cancelledExecutions === 1 ? "" : "s"}.`
            : "Cancelled matching waiting runs."
        );
      } else if (result.status === "ignored") {
        let ignoredMessage = "Event was ignored by routing rules.";
        if (result.reason === "no_waiting_runs") {
          ignoredMessage = "No matching waiting runs were found.";
        } else if (result.reason === "workflow_paused") {
          ignoredMessage = "Workflow is paused and cannot start new runs.";
        }

        toast.message(ignoredMessage);
      } else {
        toast.message("Execution completed without starting a new run.");
      }

      setSelectedExecutionId(null);
      setIsExecuting(false);
      updateNodesStatus(nodes, updateNodeData, "idle");
      return;
    }

    if (
      typeof result.cancelledExecutions === "number" &&
      result.cancelledExecutions > 0
    ) {
      toast.message(
        `Restarted timing after cancelling ${result.cancelledExecutions} waiting run${result.cancelledExecutions === 1 ? "" : "s"}.`
      );
    }

    // Select the new execution
    setSelectedExecutionId(result.executionId);
  } catch (error) {
    console.error("Failed to execute workflow:", error);
    toast.error(
      error instanceof Error ? error.message : "Failed to execute workflow"
    );
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
  userIntegrations: Array<{ id: string; type: IntegrationType }>;
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
  const clearGraphSelection = useSetAtom(clearGraphSelectionAtom);
  const saveWorkflow = useSetAtom(saveWorkflowAtom);
  const createWorkflow = useSetAtom(createWorkflowAtom);

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

    try {
      sessionStorage.setItem("animate-sidebar", "true");
    } catch {
      // Ignore if session storage is unavailable.
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
      workflowId: currentWorkflowId,
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
  const userIntegrations = useAtomValue(integrationsAtom);
  const [triggerExecute, setTriggerExecute] = useAtom(triggerExecuteAtom);

  const [isDuplicating, setIsDuplicating] = useState(false);
  const [allWorkflows, setAllWorkflows] = useState<
    Array<{
      id: string;
      name: string;
      updatedAt: string;
    }>
  >([]);

  // Load all workflows on mount
  useEffect(() => {
    const loadAllWorkflows = async () => {
      try {
        const workflows = await api.workflow.getAll();
        setAllWorkflows(workflows);
      } catch (error) {
        console.error("Failed to load workflows:", error);
      }
    };
    loadAllWorkflows();
  }, []);

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
    isDuplicating,
    setIsDuplicating,
    allWorkflows,
    setAllWorkflows,
    setActiveTab,
    setSelectedNodeId,
    setSelectedExecutionId,
    userIntegrations,
    triggerExecute,
    setTriggerExecute,
  };
}

// Hook for workflow actions
function useWorkflowActions(state: ReturnType<typeof useWorkflowState>) {
  const { open: openOverlay } = useOverlay();
  const navigate = useNavigate();
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
    setAllWorkflows,
    setIsDuplicating,
    setActiveTab,
    setSelectedNodeId,
    setSelectedExecutionId,
    userIntegrations,
    triggerExecute,
    setTriggerExecute,
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

  // Listen for execute trigger from keyboard shortcut
  useEffect(() => {
    if (triggerExecute) {
      setTriggerExecute(false);
      handleExecute();
    }
  }, [triggerExecute, setTriggerExecute, handleExecute]);

  const handleClearWorkflow = () => {
    openOverlay(ConfirmOverlay, {
      title: "Clear Workflow",
      message:
        "Remove every step and connection? The trigger is kept, and this saves right away.",
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
      onConfirm: async () => {
        if (!currentWorkflowId) {
          return;
        }
        try {
          await api.workflow.delete(currentWorkflowId);
          toast.success("Workflow deleted successfully");
          await navigate({ to: "/", replace: true });
        } catch (error) {
          console.error("Failed to delete workflow:", error);
          toast.error("Failed to delete workflow. Please try again.");
        }
      },
    });
  };

  const loadWorkflows = async () => {
    try {
      const workflows = await api.workflow.getAll();
      setAllWorkflows(workflows);
    } catch (error) {
      console.error("Failed to load workflows:", error);
    }
  };

  const handleDuplicate = async () => {
    if (!currentWorkflowId) {
      return;
    }

    setIsDuplicating(true);
    try {
      const newWorkflow = await api.workflow.duplicate(currentWorkflowId);
      toast.success("Workflow duplicated successfully");
      await navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: newWorkflow.id },
      });
    } catch (error) {
      console.error("Failed to duplicate workflow:", error);
      toast.error("Failed to duplicate workflow. Please try again.");
    } finally {
      setIsDuplicating(false);
    }
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

    const updatedWorkflow = outcome.workflow;
    setCurrentWorkflowMode(updatedWorkflow.mode);
    setAllWorkflows((current) =>
      current.map((workflow) =>
        workflow.id === updatedWorkflow.id ? updatedWorkflow : workflow
      )
    );
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
    handleSetWorkflowMode,
  };
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
                    disabled={state.isDuplicating}
                    onClick={actions.handleDuplicate}
                  >
                    {state.isDuplicating ? (
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
        existingWorkflowNames={state.allWorkflows.map(
          (workflow) => workflow.name
        )}
        onCreated={async (createdWorkflow) => {
          await actions.loadWorkflows();
          await navigate({
            to: "/workflows/$workflowId",
            params: { workflowId: createdWorkflow.id },
          });
        }}
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
                isDuplicating={state.isDuplicating}
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
