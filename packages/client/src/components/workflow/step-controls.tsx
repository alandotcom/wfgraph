import { useAtomValue, useSetAtom } from "jotai";
import { useId } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "#src/components/ui/button";
import { can } from "#src/lib/authorization";
import { updateNodeDataAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

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
 * The enable toggle at the foot of a phone's summary sheet for a step, shown
 * only to a person who may update the workflow. A phone has no Inspector menu
 * and no context menu, so this is where it turns a step off or on; Delete and
 * Ungroup are topology edits, which a phone does not offer.
 */
export function PhoneStepToggle({
  node,
  className,
}: {
  node: WorkflowNode;
  /** Spacing classes for the row, added to its flex layout. */
  className: string;
}) {
  if (
    !can(WfGraphOperations.workflowUpdate.id) ||
    node.data.type !== "action"
  ) {
    return null;
  }
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <StepEnableToggle node={node} />
    </div>
  );
}
