import { useQueryClient } from "@tanstack/react-query";
import { compact } from "es-toolkit/array";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { MousePointerClick, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "#src/components/ui/button";
import { ControlTooltip } from "#src/components/ui/control-tooltip";
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
import { activeShowSupersededAtom } from "#src/lib/workflow-workspace-navigation";
import { isRunInProgress } from "#src/lib/execution-logs";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  SUPERSEDED_COUNT_LIMIT,
  WORKFLOW_RUN_LIST_LIMIT,
} from "@wfgraph/shared/rpc/contracts/workflows";
import { useTopologyCapabilities } from "./canvas-interaction";
import { useNodeConfigWriter } from "./config/use-node-config-writer";
import { NodePropertiesForm } from "./node-properties-form";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { workflowNodeAriaLabel } from "#src/lib/workflow-graph-types";

/**
 * Configuring the selected node, edge, or the workflow itself.
 *
 * The editor mounts this in two places: the details column, for the Draft
 * selections no other kind shows, on a wide viewport and in the mobile
 * Reveal sequence, and the configuration sheet a narrow viewport opens for a
 * Draft with nothing selected.
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
   * that follows its selection, like the details column, leaves this
   * unset.
   */
  dismiss?: () => void;
};

/**
 * What the panel is currently configuring, for a frame that shows a title.
 * Derived from the selection so the header and canvas cannot disagree.
 */
export function useNodeConfigTitle(): string {
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const selectedEdgeId = useAtomValue(selectedEdgeAtom);

  // An edge on its own is the one selection with a title of its own. Everything
  // else is Properties, including nothing at all: "Workflow" named a set of
  // fields this panel no longer holds.
  if (selectedEdgeId && !selectedNodeId) {
    return "Connection";
  }
  return "Properties";
}

/**
 * Refresh and Delete all runs for the Runs surface, above the run list in the
 * details column and in the mobile run list sheet. The confirm callback is the
 * frame's, so each frame asks in its own way.
 */
export function RunsListActions({
  confirm,
}: {
  confirm: NodeConfigFrame["confirm"];
}) {
  const { refreshRuns, deleteRuns } = useNodeConfigWriter(null);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const queryClient = useQueryClient();
  const store = useStore();
  const canDeleteExecutions = can(
    WfGraphOperations.workflowDeleteExecutions.id
  );

  // The counts come from the run list this control sits above, as it was
  // last read, so the question names the runs the reader is looking at.
  const askToDeleteAll = () => {
    if (!currentWorkflowId) {
      return;
    }
    const showSuperseded = store.get(activeShowSupersededAtom);
    const list = queryClient.getQueryData(
      orpcQuery.workflow.getExecutions.queryKey({
        input: {
          workflowId: currentWorkflowId,
          includeSuperseded: showSuperseded,
        },
      })
    );
    confirm({
      ...deleteAllRunsPrompt(
        list && {
          statuses: list.items.map((item) => item.status),
          hiddenSupersededCount: showSuperseded ? 0 : list.supersededCount,
        }
      ),
      onConfirm: () => {
        if (canDeleteExecutions) {
          deleteRuns.mutate({ workflowId: currentWorkflowId });
        }
      },
    });
  };

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
        <ControlTooltip label="Delete all runs">
          <Button
            aria-label="Delete all runs"
            onClick={askToDeleteAll}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 />
          </Button>
        </ControlTooltip>
      ) : null}
    </div>
  );
}

/**
 * The question Delete all runs asks, from the run list as last read: the
 * status of each listed run, and how many superseded runs the list hides.
 * Deleting removes every run of the workflow, active ones included, and an
 * active run stops where it is. A list holding
 * `WORKFLOW_RUN_LIST_LIMIT` runs may have left older ones out, so its counts
 * are stated as "or more". With no list read yet the question names no count.
 */
export function deleteAllRunsPrompt(
  list:
    | { statuses: readonly string[]; hiddenSupersededCount: number }
    | undefined
): Omit<ConfirmRequest, "onConfirm"> {
  const irreversible = "This cannot be undone.";
  const total =
    list === undefined
      ? 0
      : list.statuses.length +
        Math.min(list.hiddenSupersededCount, SUPERSEDED_COUNT_LIMIT);
  if (list === undefined || total === 0) {
    return {
      title: "Delete all runs?",
      message: `This deletes every run of this workflow and its history. Deleting stops any run that is still active. ${irreversible}`,
      confirmLabel: "Delete all runs",
    };
  }
  const complete =
    list.statuses.length < WORKFLOW_RUN_LIST_LIMIT &&
    list.hiddenSupersededCount <= SUPERSEDED_COUNT_LIMIT;
  const active = list.statuses.filter(isRunInProgress).length;
  const activeSentence =
    active === 0
      ? ""
      : ` Deleting stops ${complete ? "" : "at least "}${runs(active)} that ${active === 1 ? "is" : "are"} still active.`;
  const count = complete ? runs(total) : `${total} or more runs`;
  return {
    title: `Delete ${count}?`,
    message: `This deletes every run of this workflow and its history, ${count} in all.${activeSentence} ${irreversible}`,
    confirmLabel: complete ? `Delete ${count}` : "Delete all runs",
  };
}

/** "1 run" or "2 runs". */
function runs(count: number): string {
  return `${count} ${count === 1 ? "run" : "runs"}`;
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
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const deleteSelectedItems = useSetAtom(deleteSelectedItemsAtom);
  const catalog = useExtensionCatalog();

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

  // Deleting a connection is one undo step, as deleting a step is, so it
  // happens at once with no confirmation.
  const deleteSelectedEdge = () => {
    if (!selectedEdgeId) {
      return;
    }
    deleteEdge(selectedEdgeId);
    frame.dismiss?.();
  };

  // A connection is named by the steps it joins, as the canvas names them.
  const stepName = (nodeId: string) => {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    return node ? workflowNodeAriaLabel(node.data, catalog) : "Missing step";
  };

  const confirmDeleteSelection = () => {
    frame.confirm({
      title: "Delete selected items",
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
            <Label>From</Label>
            <p className="text-sm">{stepName(selectedEdge.source)}</p>
          </div>
          <div className="space-y-2">
            <Label>To</Label>
            <p className="text-sm">{stepName(selectedEdge.target)}</p>
          </div>

          {canDelete ? (
            <div className="flex items-center gap-2 pt-4">
              <Button onClick={deleteSelectedEdge} size="sm" variant="outline">
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
        ) : null}
      </div>
    </div>
  );
}
