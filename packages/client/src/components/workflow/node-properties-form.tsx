import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { type ReactNode, useState } from "react";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { Separator } from "#src/components/ui/separator";
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
import {
  FieldIssuesProvider,
  UnclaimedFieldIssues,
} from "./config/field-issues";
import { useNodeConfigWriter } from "./config/use-node-config-writer";

/**
 * The Notes input of one node, with the element id `description`, which edits
 * the node's stored description. Each keystroke writes to the graph store.
 * The node's name is edited in the Inspector's title.
 */
export function NodeNotesField({
  node,
  disabled,
}: {
  node: WorkflowNode;
  disabled: boolean;
}) {
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  return (
    <div className="space-y-2">
      <Label htmlFor="description">Notes</Label>
      <Input
        disabled={disabled}
        id="description"
        onChange={(event) =>
          updateNodeData({
            id: node.id,
            data: { description: event.target.value },
          })
        }
        placeholder="Optional"
        value={node.data.description || ""}
      />
    </div>
  );
}

/**
 * The complete form of one step: what it does ("Does"), the settings that
 * action takes, each with the issues that name it beneath it, the action's
 * links, then its Notes after a divider, and last any issue no field on
 * screen shows. The step's name is edited in the Inspector's title. It holds settings only: disabling, duplicating and deleting
 * the step are commands of the Inspector header's ⋯ menu and the context menu.
 * Every value writes straight to the graph store, so the form can unmount and
 * mount again without losing an edit or skipping autosave.
 */
export function NodePropertiesForm({
  nodeId,
  children,
}: {
  nodeId: string;
  /** Sections a Reveal kind adds, shown after the settings and before the divider. */
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
    // chosen action needs, or to the step's name in the title.
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

        <Separator />

        <NodeNotesField
          disabled={isGenerating || !canUpdate}
          node={selectedNode}
        />

        <UnclaimedFieldIssues />
      </div>
    </FieldIssuesProvider>
  );
}
