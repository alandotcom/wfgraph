import { useAtomValue, useSetAtom } from "jotai";
import { Eye, EyeOff, Trash2, Ungroup } from "lucide-react";
import { Button } from "#src/components/ui/button";
import { can } from "#src/lib/authorization";
import { canUngroup } from "#src/lib/node-group";
import {
  deleteGroupWithMembersAtom,
  deleteNodeAtom,
  ungroupNodeAtom,
  updateNodeDataAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { deleteGroupWithStepsConfirmation } from "./group-delete-confirmation";
import type { NodeConfigFrame } from "./node-config-panel";

/**
 * The Enabled or Disabled toggle of one step. A disabled step stays in the
 * graph and the run skips it. Disabled while the build agent is editing.
 */
function StepEnableToggle({ node }: { node: WorkflowNode }) {
  const isGenerating = useAtomValue(isGeneratingAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const isDisabled = node.data.enabled === false;
  return (
    <Button
      disabled={isGenerating}
      onClick={() =>
        updateNodeData({ id: node.id, data: { enabled: isDisabled } })
      }
      size="sm"
      variant="outline"
    >
      {isDisabled ? (
        <EyeOff className="mr-2 size-4" />
      ) : (
        <Eye className="mr-2 size-4" />
      )}
      {isDisabled ? "Disabled" : "Enabled"}
    </Button>
  );
}

/**
 * Delete one step after the frame's confirmation, then close a frame that
 * configured only that step.
 */
function DeleteStepButton({
  nodeId,
  frame,
}: {
  nodeId: string;
  frame: NodeConfigFrame;
}) {
  const deleteNode = useSetAtom(deleteNodeAtom);
  return (
    <Button
      onClick={() =>
        frame.confirm({
          title: "Delete Step",
          message:
            "Are you sure you want to delete this step? This action cannot be undone.",
          confirmLabel: "Delete",
          onConfirm: () => {
            deleteNode(nodeId);
            frame.dismiss?.();
          },
        })
      }
      size="sm"
      variant="outline"
    >
      <Trash2 className="mr-2 size-4 text-destructive" />
      <span className="text-destructive">Delete</span>
    </Button>
  );
}

/**
 * The control row of one node, shown only to a person who may update the
 * workflow: the enable toggle for a step, Ungroup for a Group or a Group
 * member, and a confirmed delete. A Group's delete removes the frame with every
 * step inside it, since Ungroup is how the frame alone is removed.
 */
export function NodeControls({
  node,
  frame,
  className,
}: {
  node: WorkflowNode;
  frame: NodeConfigFrame;
  /** Spacing classes for the row, added to its flex layout. */
  className: string;
}) {
  const ungroupNode = useSetAtom(ungroupNodeAtom);
  const deleteGroupWithMembers = useSetAtom(deleteGroupWithMembersAtom);
  if (!can(WfGraphOperations.workflowUpdate.id)) {
    return null;
  }
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {/* A Group frame is organization only and has no enabled state. */}
      {node.data.type === "action" ? <StepEnableToggle node={node} /> : null}
      {canUngroup(node) ? (
        <Button
          onClick={() => ungroupNode(node.id)}
          size="sm"
          variant="outline"
        >
          <Ungroup className="mr-2 size-4" />
          Ungroup
        </Button>
      ) : null}
      {isGroupNode(node) ? (
        <Button
          onClick={() =>
            frame.confirm(
              deleteGroupWithStepsConfirmation(() => {
                deleteGroupWithMembers(node.id);
                frame.dismiss?.();
              })
            )
          }
          size="sm"
          variant="outline"
        >
          <Trash2 className="mr-2 size-4 text-destructive" />
          <span className="text-destructive">Delete Group and Steps</span>
        </Button>
      ) : (
        <DeleteStepButton frame={frame} nodeId={node.id} />
      )}
    </div>
  );
}
