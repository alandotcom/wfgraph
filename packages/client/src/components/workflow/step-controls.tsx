import { useAtomValue, useSetAtom } from "jotai";
import { Eye, EyeOff, Trash2 } from "lucide-react";
import { Button } from "#src/components/ui/button";
import {
  deleteNodeAtom,
  updateNodeDataAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";
import type { NodeConfigFrame } from "./node-config-panel";

/**
 * The Enabled or Disabled toggle of one step. A disabled step stays in the
 * graph and the run skips it. Disabled while the build agent is editing.
 */
export function StepEnableToggle({ node }: { node: WorkflowNode }) {
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
export function DeleteStepButton({
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
