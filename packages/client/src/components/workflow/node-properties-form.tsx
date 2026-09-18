import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Trash2, Ungroup } from "lucide-react";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { can } from "#src/lib/authorization";
import { canUngroup } from "#src/lib/node-group";
import {
  deleteGroupWithMembersAtom,
  newlyCreatedNodeIdAtom,
  nodesAtom,
  ungroupNodeAtom,
  updateNodeDataAtom,
} from "#src/lib/workflow-graph-store";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { ActionConfig } from "./config/action-config";
import { ActionGrid } from "./config/action-grid";
import { LifecyclePanel } from "./config/lifecycle-panel";
import { useNodeConfigWriter } from "./config/use-node-config-writer";
import { deleteGroupWithStepsConfirmation } from "./group-delete-confirmation";
import type { NodeConfigFrame } from "./node-config-panel";
import { DeleteStepButton, StepEnableToggle } from "./step-controls";

/**
 * The complete configuration form of one node, whether a step, a Group, or the
 * Lifecycle node: its label and description, its node-specific configuration,
 * and its enable, ungroup, and delete controls. Every value writes straight to
 * the graph store, so the form can unmount and mount again without losing an
 * edit or skipping autosave.
 */
export function NodePropertiesForm({
  nodeId,
  frame,
}: {
  nodeId: string;
  frame: NodeConfigFrame;
}) {
  const { updateConfig: handleUpdateConfig } = useNodeConfigWriter(nodeId);
  const nodes = useAtomValue(nodesAtom);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const canUpdate = can(WfGraphOperations.workflowUpdate.id);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const ungroupSelected = useSetAtom(ungroupNodeAtom);
  const deleteGroupWithMembers = useSetAtom(deleteGroupWithMembersAtom);
  const [newlyCreatedNodeId, setNewlyCreatedNodeId] = useAtom(
    newlyCreatedNodeIdAtom
  );

  const selectedNode = nodes.find((node) => node.id === nodeId);
  if (!selectedNode) {
    return null;
  }

  const handleUpdateLabel = (label: string) => {
    updateNodeData({ id: selectedNode.id, data: { label } });
  };

  const handleUpdateDescription = (description: string) => {
    updateNodeData({ id: selectedNode.id, data: { description } });
  };

  const confirmDeleteGroupWithSteps = () => {
    frame.confirm(
      deleteGroupWithStepsConfirmation(() => {
        deleteGroupWithMembers(selectedNode.id);
        frame.dismiss?.();
      })
    );
  };

  // An action node with no action chosen yet gets the picker instead of a
  // config form, and the picker is the whole screen while it is up.
  if (
    selectedNode.data.type === "action" &&
    !selectedNode.data.config?.actionType &&
    canUpdate
  ) {
    return (
      <div className="px-4 pt-4">
        <ActionGrid
          disabled={isGenerating}
          isNewlyCreated={selectedNode.id === newlyCreatedNodeId}
          // A grid keyed to the node it configures starts fresh for each
          // one: the search box empties, and a node dropped moments ago gets
          // the autofocus that only fires on mount.
          key={selectedNode.id}
          onSelectAction={(actionType) => {
            handleUpdateConfig({ actionType });
            if (selectedNode.id === newlyCreatedNodeId) {
              setNewlyCreatedNodeId(null);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {selectedNode.data.type !== "action" ||
      selectedNode.data.config?.actionType ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="label">Label</Label>
            <Input
              disabled={isGenerating || !canUpdate}
              id="label"
              onChange={(e) => handleUpdateLabel(e.target.value)}
              value={selectedNode.data.label}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Input
              disabled={isGenerating || !canUpdate}
              id="description"
              onChange={(e) => handleUpdateDescription(e.target.value)}
              placeholder="Optional description"
              value={selectedNode.data.description || ""}
            />
          </div>
        </div>
      ) : null}

      {selectedNode.data.type === "group" ? (
        <p className="text-muted-foreground text-sm">
          Lookups in a frame share an incoming step. They can join at one
          Condition or leave separately for the same target and target handle.
          Only Condition True can continue.
        </p>
      ) : null}

      {selectedNode.data.type === "lifecycle" ? (
        /* The Lifecycle Rules are the whole of the entry node's configuration.
           The payload shape is not asked for here: it belongs to the Events the
           rules name, and the editor derives the fields it offers from them. */
        <LifecyclePanel
          config={selectedNode.data.config || {}}
          disabled={isGenerating || !canUpdate}
          // Keyed to the node, so the pickers inside start clean for the
          // entry node being configured. The panel itself holds no state,
          // but its comboboxes hold a search term, and opening another
          // workflow puts its entry node in this same slot: unkeyed, the
          // second node arrives with the first one's filter still typed in.
          key={selectedNode.id}
          onUpdateConfig={handleUpdateConfig}
        />
      ) : null}

      {selectedNode.data.type === "action" &&
      !selectedNode.data.config?.actionType ? (
        <div className="rounded-lg border border-muted bg-muted/30 p-3">
          <p className="text-muted-foreground text-sm">
            No action configured for this step.
          </p>
        </div>
      ) : null}

      {selectedNode.data.type === "action" &&
      selectedNode.data.config?.actionType ? (
        <ActionConfig
          config={selectedNode.data.config || {}}
          disabled={isGenerating || !canUpdate}
          canUpdate={canUpdate}
          key={selectedNode.id}
          onUpdateConfig={handleUpdateConfig}
        />
      ) : null}

      {canUpdate ? (
        <div className="flex items-center gap-2 pt-4">
          {/* A step switches on and off by itself, inside a Group or outside
              one. A frame is organization only and has no enabled state. */}
          {selectedNode.data.type === "action" ? (
            <StepEnableToggle node={selectedNode} />
          ) : null}
          {canUngroup(selectedNode) ? (
            <Button
              onClick={() => ungroupSelected(selectedNode.id)}
              size="sm"
              variant="outline"
            >
              <Ungroup className="mr-2 size-4" />
              Ungroup
            </Button>
          ) : null}
          {/* Ungroup is how a frame alone is removed, so a frame's delete
              button is the explicit, confirmed delete of the Group's steps. */}
          {isGroupNode(selectedNode) ? (
            <Button
              onClick={confirmDeleteGroupWithSteps}
              size="sm"
              variant="outline"
            >
              <Trash2 className="mr-2 size-4 text-destructive" />
              <span className="text-destructive">Delete Group and Steps</span>
            </Button>
          ) : (
            <DeleteStepButton frame={frame} nodeId={selectedNode.id} />
          )}
        </div>
      ) : null}
    </div>
  );
}
