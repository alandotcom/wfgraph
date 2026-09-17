import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { can } from "#src/lib/authorization";
import {
  newlyCreatedNodeIdAtom,
  nodesAtom,
  updateNodeDataAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { ActionConfig } from "./config/action-config";
import { ActionGrid } from "./config/action-grid";
import { LifecyclePanel } from "./config/lifecycle-panel";
import { useNodeConfigWriter } from "./config/use-node-config-writer";
import type { NodeConfigFrame } from "./node-config-panel";
import { NodeControls } from "./step-controls";

/**
 * The Label and Description inputs of one node, with the element ids `label`
 * and `description`. Each keystroke writes to the graph store.
 */
export function NodeDetailsFields({
  node,
  disabled,
}: {
  node: WorkflowNode;
  disabled: boolean;
}) {
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="label">Label</Label>
        <Input
          disabled={disabled}
          id="label"
          onChange={(event) =>
            updateNodeData({ id: node.id, data: { label: event.target.value } })
          }
          value={node.data.label}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Input
          disabled={disabled}
          id="description"
          onChange={(event) =>
            updateNodeData({
              id: node.id,
              data: { description: event.target.value },
            })
          }
          placeholder="Optional description"
          value={node.data.description || ""}
        />
      </div>
    </div>
  );
}

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
  const [newlyCreatedNodeId, setNewlyCreatedNodeId] = useAtom(
    newlyCreatedNodeIdAtom
  );

  const selectedNode = nodes.find((node) => node.id === nodeId);
  if (!selectedNode) {
    return null;
  }

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
        <NodeDetailsFields
          disabled={isGenerating || !canUpdate}
          node={selectedNode}
        />
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

      <NodeControls className="pt-4" frame={frame} node={selectedNode} />
    </div>
  );
}
