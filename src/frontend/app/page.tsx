import { useAtomValue, useSetAtom } from "jotai";
import { nanoid } from "nanoid";
import { useCallback, useEffect } from "react";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  currentWorkflowVisibilityAtom,
  edgesAtom,
  hasSidebarBeenShownAtom,
  isWorkflowOwnerAtom,
  nodesAtom,
  propertiesPanelActiveTabAtom,
  selectedEdgeAtom,
  selectedExecutionIdAtom,
  selectedNodeAtom,
  type WorkflowNode,
  workflowNameErrorAtom,
  workflowNotFoundAtom,
} from "@/client/lib/workflow-store";
import { WorkflowSidebarPanel } from "@/components/workflow/workflow-sidebar-panel";

// Helper function to create a default trigger node
function createDefaultTriggerNode() {
  return {
    id: nanoid(),
    type: "trigger" as const,
    position: { x: 0, y: 0 },
    data: {
      label: "",
      description: "",
      type: "trigger" as const,
      config: { triggerType: "Webhook" },
      status: "idle" as const,
    },
  };
}

const Home = () => {
  const setNodes = useSetAtom(nodesAtom);
  const setEdges = useSetAtom(edgesAtom);
  const setCurrentWorkflowId = useSetAtom(currentWorkflowIdAtom);
  const setCurrentWorkflowName = useSetAtom(currentWorkflowNameAtom);
  const setCurrentWorkflowVisibility = useSetAtom(
    currentWorkflowVisibilityAtom
  );
  const setIsWorkflowOwner = useSetAtom(isWorkflowOwnerAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const setSelectedEdge = useSetAtom(selectedEdgeAtom);
  const setSelectedExecutionId = useSetAtom(selectedExecutionIdAtom);
  const setPropertiesPanelActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const setWorkflowNotFound = useSetAtom(workflowNotFoundAtom);
  const setWorkflowNameError = useSetAtom(workflowNameErrorAtom);
  const setHasSidebarBeenShown = useSetAtom(hasSidebarBeenShownAtom);
  const currentWorkflowName = useAtomValue(currentWorkflowNameAtom);

  // Reset sidebar animation state when on homepage
  useEffect(() => {
    setHasSidebarBeenShown(false);
    setWorkflowNameError(null);
  }, [setHasSidebarBeenShown, setWorkflowNameError]);

  // Update page title when workflow name changes
  useEffect(() => {
    document.title = `${currentWorkflowName} - Rova`;
  }, [currentWorkflowName]);

  // Handler to add the first node (replaces the "add" node)
  const handleAddNode = useCallback(() => {
    const newNode: WorkflowNode = createDefaultTriggerNode();
    // Replace all nodes (removes the "add" node)
    setNodes([newNode]);
  }, [setNodes]);

  // Initialize with a temporary "add" node on mount
  useEffect(() => {
    const addNodePlaceholder: WorkflowNode = {
      id: "add-node-placeholder",
      type: "add",
      position: { x: 0, y: 0 },
      data: {
        label: "",
        type: "add",
        onClick: handleAddNode,
      },
      draggable: false,
      selectable: false,
    };
    setNodes([addNodePlaceholder]);
    setEdges([]);
    setCurrentWorkflowId(null);
    setCurrentWorkflowName("New Workflow");
    setCurrentWorkflowVisibility("private");
    setIsWorkflowOwner(true);
    setSelectedNode(null);
    setSelectedEdge(null);
    setSelectedExecutionId(null);
    setPropertiesPanelActiveTab("properties");
    setWorkflowNotFound(false);
    setWorkflowNameError(null);
  }, [
    setNodes,
    setEdges,
    setCurrentWorkflowId,
    setCurrentWorkflowName,
    setCurrentWorkflowVisibility,
    setIsWorkflowOwner,
    setSelectedNode,
    setSelectedEdge,
    setSelectedExecutionId,
    setPropertiesPanelActiveTab,
    setWorkflowNotFound,
    setWorkflowNameError,
    handleAddNode,
  ]);

  // Canvas and toolbar are rendered by PersistentCanvas in the layout
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden">
      <WorkflowSidebarPanel />
    </div>
  );
};

export default Home;
