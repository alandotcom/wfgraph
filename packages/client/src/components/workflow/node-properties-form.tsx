import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { type ReactNode, useState } from "react";
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
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { newStepFocusTarget } from "./canvas-reveal/reveal-edit-target";
import { requestRevealEditFocusAtom } from "./canvas-reveal/reveal-requests";
import { ActionConfig } from "./config/action-config";
import {
  ACTION_CHOICE_ID,
  ActionChoiceField,
} from "./config/action-choice-field";
import { ActionLinks } from "./config/action-links";
import { FieldIssuesProvider } from "./config/field-issues";
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
 * and its enable, ungroup, and delete controls. Each validation issue that
 * names a field shows beneath that field. Every value writes straight to
 * the graph store, so the form can unmount and mount again without losing an
 * edit or skipping autosave.
 */
export function NodePropertiesForm({
  nodeId,
  frame,
  children,
}: {
  nodeId: string;
  frame: NodeConfigFrame;
  /** Sections a Reveal kind adds, shown after the configuration and before the enable, ungroup, and delete controls. */
  children?: ReactNode | undefined;
}) {
  const { updateConfig: handleUpdateConfig } = useNodeConfigWriter(nodeId);
  const nodes = useAtomValue(nodesAtom);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const canUpdate = can(WfGraphOperations.workflowUpdate.id);
  const [newlyCreatedNodeId, setNewlyCreatedNodeId] = useAtom(
    newlyCreatedNodeIdAtom
  );
  const requestEditFocus = useSetAtom(requestRevealEditFocusAtom);
  const catalog = useExtensionCatalog();
  // The step whose action list a person opened to change its action.
  const [choosingFor, setChoosingFor] = useState<string | null>(null);

  const selectedNode = nodes.find((node) => node.id === nodeId);
  if (!selectedNode) {
    return null;
  }
  const selectedActionId = actionTypeOf(selectedNode);
  const isStep = selectedNode.data.type === "action";
  const chooseAction = (actionType: string) => {
    handleUpdateConfig({ actionType });
    setChoosingFor(null);
    // The list leaves with the choice, so focus moves to the first field the
    // chosen action needs, or to the label.
    requestEditFocus({
      nodeId: selectedNode.id,
      targetId: newStepFocusTarget(
        {
          ...selectedNode,
          data: {
            ...selectedNode.data,
            config: { ...selectedNode.data.config, actionType },
          },
        },
        catalog
      ),
    });
    if (selectedNode.id === newlyCreatedNodeId) {
      setNewlyCreatedNodeId(null);
    }
  };

  // While a step's action is being chosen, a step with none yet included,
  // the field that says what it does is open and is the whole form.
  if (
    isStep &&
    canUpdate &&
    (selectedActionId === undefined || choosingFor === selectedNode.id)
  ) {
    return (
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-4">
        <ActionChoiceField
          actionId={selectedActionId}
          disabled={isGenerating}
          focusSearch={
            selectedActionId === undefined
              ? selectedNode.id === newlyCreatedNodeId
              : true
          }
          // Keyed to the step it configures, so the search box empties for
          // each one and a step added moments ago gets the focus that only
          // fires on mount.
          key={selectedNode.id}
          onChoose={chooseAction}
          onOpenChange={(open) => {
            setChoosingFor(open ? selectedNode.id : null);
            // Closed, the list hands focus back to the field, which the
            // form draws again in its place.
            if (!open) {
              requestEditFocus({
                nodeId: selectedNode.id,
                targetId: ACTION_CHOICE_ID,
              });
            }
          }}
          open
        />
      </div>
    );
  }

  return (
    <FieldIssuesProvider nodeId={selectedNode.id}>
      <div className="space-y-4 p-4">
        <NodeDetailsFields
          disabled={isGenerating || !canUpdate}
          node={selectedNode}
        />

        {isStep ? (
          <ActionChoiceField
            actionId={selectedActionId}
            disabled={isGenerating || !canUpdate}
            focusSearch={false}
            onChoose={chooseAction}
            onOpenChange={(open) =>
              setChoosingFor(open ? selectedNode.id : null)
            }
            open={false}
          />
        ) : null}

        {selectedNode.data.type === "group" ? (
          <p className="text-muted-foreground text-sm">
            Steps in a Group run the same way they would outside it. A Group is
            entered from one outlet outside it, and that outlet can lead to
            several steps. Inside, steps can branch, join, and end. The Group
            continues outside from at most one outlet.
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
        selectedNode.data.config?.actionType ? (
          <ActionConfig
            config={selectedNode.data.config || {}}
            disabled={isGenerating || !canUpdate}
            canUpdate={canUpdate}
            key={selectedNode.id}
            onUpdateConfig={handleUpdateConfig}
          />
        ) : null}

        {selectedActionId === undefined ? null : (
          <ActionLinks actionId={selectedActionId} nodeId={selectedNode.id} />
        )}

        {children}

        <NodeControls className="pt-4" frame={frame} node={selectedNode} />
      </div>
    </FieldIssuesProvider>
  );
}
