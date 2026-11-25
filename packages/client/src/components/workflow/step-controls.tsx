import { useAtomValue, useSetAtom } from "jotai";
import { useId } from "react";
import { Eye, EyeOff, Trash2, Ungroup } from "lucide-react";
import { Button } from "#src/components/ui/button";
import { can } from "#src/lib/authorization";
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
import { useTopologyCapabilities } from "./canvas-interaction";
import { deleteGroupWithStepsConfirmation } from "./group-delete-confirmation";
import type { NodeConfigFrame } from "./node-config-panel";

/**
 * Turns one step off or on. A disabled step stays in the graph, and a run
 * that reaches it stops on that path: the step and everything after it on the
 * path do not run. The button names the action it takes, and a caption beside
 * it states that consequence in both states. Disabled while the build agent
 * is editing.
 */
function StepEnableToggle({ node }: { node: WorkflowNode }) {
  const isGenerating = useAtomValue(isGeneratingAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const consequenceId = useId();
  const isDisabled = node.data.enabled === false;
  return (
    <>
      <Button
        aria-describedby={consequenceId}
        disabled={isGenerating}
        onClick={() =>
          updateNodeData({ id: node.id, data: { enabled: isDisabled } })
        }
        size="sm"
        variant="outline"
      >
        {isDisabled ? (
          <Eye className="mr-2 size-4" />
        ) : (
          <EyeOff className="mr-2 size-4" />
        )}
        {isDisabled ? "Enable step" : "Disable step"}
      </Button>
      <span className="text-muted-foreground text-xs" id={consequenceId}>
        {isDisabled
          ? "Runs stop at this step."
          : "Disabling ends the path at this step."}
      </span>
    </>
  );
}

/**
 * Delete one step, then close a frame that configured only that step. Undo
 * restores the step, so the delete asks for no confirmation.
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
      onClick={() => {
        deleteNode(nodeId);
        frame.dismiss?.();
      }}
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
 * member, and a delete. A step's delete happens at once. A Group's delete is
 * confirmed and removes the frame with every step inside it, since Ungroup is
 * how the frame alone is removed. The
 * Lifecycle Node is the workflow's entry and cannot be deleted, so it has none.
 * Ungroup and delete follow the topology capabilities, so a phone shows the
 * toggle alone.
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
  const topology = useTopologyCapabilities();
  if (
    !can(WfGraphOperations.workflowUpdate.id) ||
    node.data.type === "lifecycle" ||
    (node.data.type !== "action" &&
      !topology.canDelete &&
      !topology.canUngroup(node))
  ) {
    return null;
  }
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {/* A Group frame is organization only and has no enabled state. */}
      {node.data.type === "action" ? <StepEnableToggle node={node} /> : null}
      {topology.canUngroup(node) ? (
        <Button
          onClick={() => ungroupNode(node.id)}
          size="sm"
          variant="outline"
        >
          <Ungroup className="mr-2 size-4" />
          Ungroup
        </Button>
      ) : null}
      {!topology.canDelete ? null : isGroupNode(node) ? (
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
          <span className="text-destructive">Delete Group and steps</span>
        </Button>
      ) : (
        <DeleteStepButton frame={frame} nodeId={node.id} />
      )}
    </div>
  );
}
