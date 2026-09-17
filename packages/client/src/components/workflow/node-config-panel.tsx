import { compact } from "es-toolkit/array";
import { useAtomValue, useSetAtom } from "jotai";
import { Eraser, MousePointerClick, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import {
  deleteEdgeAtom,
  deleteSelectedItemsAtom,
  canvasSelectionAtom,
  edgesAtom,
  nodesAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { can } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { WorkflowChangesPanel } from "./workflow-changes-panel";
import { useWorkflowComparisonActions } from "./use-workflow-comparison-actions";
import { useTopologyCapabilities } from "./canvas-interaction";
import { useNodeConfigWriter } from "./config/use-node-config-writer";
import { NodePropertiesForm } from "./node-properties-form";
import { WorkflowRuns } from "./workflow-runs";

/**
 * Configuring the selected node, edge, or the workflow itself.
 *
 * The editor mounts this in two places: Canvas Reveal, for Changes and the
 * Draft selections no other Reveal kind shows, on a wide viewport and in the
 * mobile Reveal sequence, and the configuration sheet a narrow viewport opens
 * for Runs, Changes, and a Draft with nothing selected.
 * Everything the two placements share is here; what a frame genuinely owns is
 * `NodeConfigFrame`.
 */

/** A destructive action the user has to agree to before it happens. */
export type ConfirmRequest = {
  title: string;
  message: string;
  /** Wording on the button that goes through with it. */
  confirmLabel: string;
  onConfirm: () => void;
};

/** What the panel cannot decide for itself, because the frame around it owns it. */
export type NodeConfigFrame = {
  /** How this frame asks the user to confirm. */
  confirm: (request: ConfirmRequest) => void;
  /**
   * Close the frame, once what it was configuring no longer exists. A frame
   * that closes when its selection goes away, like Canvas Reveal, leaves this
   * unset.
   */
  dismiss?: () => void;
};

/**
 * What the panel is currently configuring, for a frame that shows a title.
 * Derived from the workspace so the header and canvas cannot disagree.
 */
export function useNodeConfigTitle(): string {
  const workspaceView = useAtomValue(workflowWorkspaceViewAtom);
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const selectedEdgeId = useAtomValue(selectedEdgeAtom);

  if (workspaceView === "runs") {
    return "Runs";
  }
  if (workspaceView === "changes") {
    return "Changes";
  }
  // An edge on its own is the one selection with a title of its own. Everything
  // else is Properties, including nothing at all: "Workflow" named a set of
  // fields this panel no longer holds.
  if (selectedEdgeId && !selectedNodeId) {
    return "Connection";
  }
  return "Properties";
}

/**
 * Refresh and Clear All for the Runs surface. In Canvas Reveal they sit above
 * the run list; in the sheet they trail the run list's title. The confirm
 * callback is the frame's, so Canvas Reveal and the sheet can each ask in their
 * own way.
 */
export function RunsPanelActions({
  confirm,
}: {
  confirm: NodeConfigFrame["confirm"];
}) {
  const { refreshRuns, deleteRuns } = useNodeConfigWriter(null);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const canDeleteExecutions = can(
    WfGraphOperations.workflowDeleteExecutions.id
  );

  return (
    <div className="flex shrink-0 items-center">
      <Button
        aria-label="Refresh"
        onClick={refreshRuns}
        size="icon"
        type="button"
        variant="ghost"
      >
        <RefreshCw />
      </Button>
      {canDeleteExecutions ? (
        <Button
          aria-label="Clear All"
          onClick={() => {
            confirm({
              title: "Delete All Runs",
              message:
                "Are you sure you want to delete all workflow runs? This action cannot be undone.",
              confirmLabel: "Delete",
              onConfirm: () => {
                if (currentWorkflowId && canDeleteExecutions) {
                  deleteRuns.mutate({ workflowId: currentWorkflowId });
                }
              },
            });
          }}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Eraser />
        </Button>
      ) : null}
    </div>
  );
}

/** "1 step", "2 steps", or undefined for none. */
function countPart(
  count: number,
  singular: string,
  plural: string
): string | undefined {
  return count > 0 ? `${count} ${count === 1 ? singular : plural}` : undefined;
}

/**
 * The confirmation wording for deleting a multiple selection. `deletedText`
 * names the selected steps and connections the delete removes, and
 * `frameCount` is the number of selected Group frames the delete ungroups.
 */
function deleteSelectionMessage(input: {
  deletedText: string;
  frameCount: number;
}): string {
  const { deletedText, frameCount } = input;
  const groups = frameCount === 1 ? "Group" : "Groups";
  if (deletedText === "") {
    return `Are you sure you want to ungroup ${frameCount} ${groups}? Their steps and connections stay in the workflow.`;
  }
  const ungroupSentence =
    frameCount === 0
      ? ""
      : ` The selected ${groups} ${frameCount === 1 ? "is" : "are"} ungrouped, and the steps inside that are not selected stay in the workflow.`;
  return `Are you sure you want to delete ${deletedText}?${ungroupSentence}`;
}

export function NodeConfigPanel({ frame }: { frame: NodeConfigFrame }) {
  const workspaceView = useAtomValue(workflowWorkspaceViewAtom);
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const selectedEdgeId = useAtomValue(selectedEdgeAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const { canDelete } = useTopologyCapabilities();
  const comparisonActions = useWorkflowComparisonActions();
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const deleteSelectedItems = useSetAtom(deleteSelectedItemsAtom);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);

  const selection = useAtomValue(canvasSelectionAtom);
  const selectedNodes = nodes.filter((node) =>
    selection.nodeIds.includes(node.id)
  );
  const selectedEdges = edges.filter((edge) =>
    selection.edgeIds.includes(edge.id)
  );
  const hasMultipleSelections = selectedNodes.length + selectedEdges.length > 1;

  // A selected frame is ungrouped by a delete, so it is counted as a Group
  // and kept out of the steps the delete removes.
  const selectedFrameCount = selectedNodes.filter((node) =>
    isGroupNode(node)
  ).length;
  const selectedStepsPart = countPart(
    selectedNodes.length - selectedFrameCount,
    "step",
    "steps"
  );
  const selectedFramesPart = countPart(selectedFrameCount, "Group", "Groups");
  const selectedEdgesPart = countPart(
    selectedEdges.length,
    "connection",
    "connections"
  );
  const selectionText = compact([
    selectedStepsPart,
    selectedFramesPart,
    selectedEdgesPart,
  ]).join(" and ");
  const deletedText = compact([selectedStepsPart, selectedEdgesPart]).join(
    " and "
  );

  const confirmDeleteEdge = () => {
    if (!selectedEdgeId) {
      return;
    }
    frame.confirm({
      title: "Delete Connection",
      message:
        "Are you sure you want to delete this connection? This action cannot be undone.",
      confirmLabel: "Delete",
      onConfirm: () => {
        deleteEdge(selectedEdgeId);
        frame.dismiss?.();
      },
    });
  };

  const confirmDeleteSelection = () => {
    frame.confirm({
      title: "Delete Selected Items",
      message: deleteSelectionMessage({
        deletedText,
        frameCount: selectedFrameCount,
      }),
      confirmLabel: "Delete",
      onConfirm: () => {
        deleteSelectedItems();
        frame.dismiss?.();
      },
    });
  };

  const renderPropertiesContent = () => {
    if (hasMultipleSelections) {
      return (
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <Label>Selection</Label>
            <p className="text-muted-foreground text-sm">
              {selectionText} selected
            </p>
          </div>
          {canDelete ? (
            <div className="flex items-center gap-2 pt-4">
              <Button
                onClick={confirmDeleteSelection}
                size="sm"
                variant="outline"
              >
                <Trash2 className="mr-2 size-4 text-destructive" />
                <span className="text-destructive">Delete</span>
              </Button>
            </div>
          ) : null}
        </div>
      );
    }

    if (selectedEdge && !selectedNode) {
      return (
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <Label htmlFor="edge-id">Connection ID</Label>
            <Input disabled id="edge-id" value={selectedEdge.id} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edge-source">Source</Label>
            <Input disabled id="edge-source" value={selectedEdge.source} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edge-target">Target</Label>
            <Input disabled id="edge-target" value={selectedEdge.target} />
          </div>

          {canDelete ? (
            <div className="flex items-center gap-2 pt-4">
              <Button onClick={confirmDeleteEdge} size="sm" variant="outline">
                <Trash2 className="mr-2 size-4 text-destructive" />
                <span className="text-destructive">Delete</span>
              </Button>
            </div>
          ) : null}
        </div>
      );
    }

    // Nothing selected. The workflow's own settings live in the menu beside
    // its name, so this is an empty state rather than a second place to rename
    // or delete the workflow from.
    if (!selectedNode) {
      return (
        <div className="flex min-h-full flex-col items-center justify-center gap-2 p-8 text-center">
          <MousePointerClick className="size-5 text-muted-foreground" />
          <p className="font-medium text-sm">Nothing selected</p>
          <p className="text-muted-foreground text-sm">
            Select a step on the canvas to configure it.
          </p>
          <p className="text-muted-foreground text-xs">
            This workflow's own settings are in the menu beside its name.
          </p>
        </div>
      );
    }

    return <NodePropertiesForm frame={frame} nodeId={selectedNode.id} />;
  };

  return (
    // `flex-1` rather than a full height: both frames are flex columns, and the
    // sheet puts a header above this.
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      data-testid="properties-panel"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {workspaceView === "draft" ? (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable_both-edges]">
            {renderPropertiesContent()}
          </div>
        ) : workspaceView === "changes" ? (
          <WorkflowChangesPanel actions={comparisonActions} />
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden">
            <WorkflowRuns
              listActions={<RunsPanelActions confirm={frame.confirm} />}
            />
          </div>
        )}
      </div>
    </div>
  );
}
