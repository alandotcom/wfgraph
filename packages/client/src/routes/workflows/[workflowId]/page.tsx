import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { toast } from "sonner";
import { AgentPanel } from "#src/components/agent/agent-panel";
import { Button } from "#src/components/ui/button";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import { WorkflowCanvas } from "#src/components/workflow/workflow-canvas";
import { WorkflowDraftSync } from "#src/components/workflow/workflow-draft-sync";
import { WorkflowSidebarPanel } from "#src/components/workflow/workflow-sidebar-panel";
import { WorkflowStatusStrip } from "#src/components/workflow/workflow-status-strip";
import { WorkflowToolbar } from "#src/components/workflow/workflow-toolbar";
import { useAfterCommit, useUnmountCleanup } from "#src/hooks/effects";
import { isAgentEnabled } from "#src/lib/extensions";
import { isRunInProgress } from "#src/lib/execution-logs";
import { orpcQuery } from "#src/lib/rpc-query";
import { can } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import {
  endWorkflowEditorLifetimeAtom,
  isExecutionOverlayActiveAtom,
  nodesAtom,
  setNodeStatusesAtom,
} from "#src/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  lastSaveErrorAtom,
  workflowNotFoundAtom,
  workflowLoadErrorAtom,
} from "#src/lib/workflow-save-store";
import {
  isExecutingAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";

/** How often a run that is still going has its progress read back. */
const RUN_STATUS_POLL_MS = 500;

const WorkflowEditor = () => {
  const endWorkflowEditorLifetime = useSetAtom(endWorkflowEditorLifetimeAtom);
  useUnmountCleanup(() => endWorkflowEditorLifetime());
  const lastSaveError = useAtomValue(lastSaveErrorAtom);
  const nodes = useAtomValue(nodesAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const [selectedExecutionId] = useAtom(selectedExecutionIdAtom);
  const isExecutionOverlayActive = useAtomValue(isExecutionOverlayActiveAtom);
  const setIsExecuting = useSetAtom(isExecutingAtom);
  const setNodeStatuses = useSetAtom(setNodeStatusesAtom);
  const workflowNotFound = useAtomValue(workflowNotFoundAtom);
  const workflowLoadError = useAtomValue(workflowLoadErrorAtom);
  const canUpdate = can(WfGraphOperations.workflowUpdate.id);

  // A debounced autosave has no caller waiting on it, so a failure would
  // otherwise reach only the console while the editor looked saved.
  //
  // Every failure is toasted, including the 400s this used to swallow. Those
  // were half-built nodes the save battery refused, which made the common case
  // of an editor session a silent dropped write; the battery no longer asks, so
  // a 400 here is now something the builder has to be told about.
  useAfterCommit(lastSaveError, () => {
    if (lastSaveError) {
      toast.error(lastSaveError.message || "Failed to save workflow");
    }
  });

  // While a run is on screen its progress is read back every half second. The
  // predicate is what stops it: once the run reaches a terminal status there is
  // nothing further to learn, which the hand-managed interval this replaced had
  // to work out for itself in three places, including its error path.
  const executionStatusQuery = useQuery({
    ...orpcQuery.workflow.getExecutionStatus.queryOptions({
      input: { executionId: selectedExecutionId ?? "" },
    }),
    enabled:
      selectedExecutionId !== null &&
      can(WfGraphOperations.workflowGetExecutionStatus.id),
    staleTime: 0,
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      isRunInProgress(query.state.data?.status) ? RUN_STATUS_POLL_MS : false,
  });

  const executionStatus = executionStatusQuery.data;

  // Projecting a run's progress onto the graph. The statuses live on the nodes
  // because that is where React Flow reads them from, so this is a write into a
  // store rather than something render can return, and the thing it follows is
  // a server response rather than anything the user did. Overlay presence is in
  // the key so a null→present rebuild (late hydrate restore) re-projects chips
  // onto the new nodes; completed runs do not poll, so identity alone is not enough.
  const nodeStatusKey =
    executionStatus?.nodeStatuses
      .map((nodeStatus) => `${nodeStatus.nodeId}=${nodeStatus.status}`)
      .join(",") ?? "";
  useAfterCommit(
    selectedExecutionId === null
      ? "idle"
      : `${selectedExecutionId}:${isExecutionOverlayActive}:${
          executionStatus === undefined
            ? "loading"
            : `${executionStatus.status}:${nodeStatusKey}`
        }`,
    () => {
      if (!selectedExecutionId) {
        setNodeStatuses(
          nodes.map((node) => ({ nodeId: node.id, status: "idle" }))
        );
        setIsExecuting(false);
        return;
      }

      if (!executionStatus) {
        return;
      }

      setNodeStatuses(
        executionStatus.nodeStatuses.map((nodeStatus) => ({
          nodeId: nodeStatus.nodeId,
          status: nodeStatus.status === "pending" ? "idle" : nodeStatus.status,
        }))
      );
      setIsExecuting(isRunInProgress(executionStatus.status));
    }
  );

  return (
    // The page the shell is inset on. It owns the viewport height, because
    // `h-dvh` on the shell plus an inset is a viewport's worth of editor
    // pushed `--editor-inset` past the bottom edge. Padding rather than a
    // margin on the shell for the same reason.
    //
    // Neither this nor the frame inside it is positioned, so the shell stays
    // the containing block every absolute child of the editor measured
    // against before there was a page under it.
    <div className="h-dvh w-full bg-page p-[var(--editor-inset)]">
      {/* The one shadow lifting the editor off the page, on its own element
          because the shell below is clipped by a `clip-path`, which takes an
          element's own box-shadow away with everything else outside the shape.
          The frame carries the shadow outside that clip and the same radius, so
          the shell fills it exactly and the two curves are one curve. */}
      <div className="size-full bg-background md:rounded-xl md:shadow-xs">
        {/* The editor shell: one row, the canvas column beside the panel column.
            `relative` because the two failure overlays and the panel's collapsed
            expand button all measure themselves against the whole editor.

            Three things hold the contents inside the corner, and all three are
            needed. The radius and `overflow-hidden` clip an ordinary child.
            They do not clip a composited one: the panel animates on `transform`,
            which puts it on its own layer, and it painted its square corner over
            the rounded one and took the page margin's hit region with it. The
            `clip-path` is the form of the clip that layer cannot escape.

            `clip-path` rather than a transform, `contain: paint` or a mask,
            each of which would also clip a composited child: those three make
            this element the containing block for a `position: fixed`
            descendant, which would move any the editor ever holds. `clip-path`
            leaves position alone. It does clip a fixed descendant's painting
            and hit region, like everything else in here, so a popup inside the
            editor still has to be portalled out to escape the corner, which is
            what every one of them already does. */}
        <div className="relative flex size-full flex-col overflow-hidden md:rounded-xl md:border md:[clip-path:inset(0_round_var(--editor-shell-radius))]">
          {/* URL → selection + pinned-graph overlay. Sibling of the sidebar so it
              outlives the Runs panel; the status projection above reads what it writes. */}
          <ExecutionOverlaySync />

          {/* Workflow not found overlay */}
          {workflowNotFound && (
            <div className="absolute inset-0 z-20 flex items-center justify-center">
              <div className="rounded-lg border bg-background p-8 text-center shadow-lg">
                <h1 className="mb-2 font-semibold text-2xl">
                  Workflow Not Found
                </h1>
                <p className="mb-6 text-muted-foreground">
                  The workflow you're looking for doesn't exist or has been
                  deleted.
                </p>
                <Button render={<Link to="/" />}>Go to Dashboard</Button>
              </div>
            </div>
          )}

          {workflowLoadError && (
            <div className="absolute inset-0 z-20 flex items-center justify-center">
              <div className="rounded-lg border bg-background p-8 text-center shadow-lg">
                <h1 className="mb-2 font-semibold text-2xl">
                  Couldn't Load Workflow
                </h1>
                <p className="mb-6 text-muted-foreground">
                  {workflowLoadError}
                </p>
                <Button onClick={() => window.location.reload()}>
                  Try Again
                </Button>
              </div>
            </div>
          )}

          {currentWorkflowId && (
            <WorkflowDraftSync workflowId={currentWorkflowId} />
          )}

          <WorkflowToolbar workflowId={currentWorkflowId ?? undefined} />
          {/* The body keeps the graph beside the sidebar. The toolbar is above
              this row so its centred search control measures the editor shell. */}
          <div className="flex min-h-0 flex-1">
            {/* The canvas column: graph in the middle, status strip below.

              `min-w-0` stops the graph from widening the column past the space the
              panel leaves it. */}
            <div className="flex min-w-0 flex-1 flex-col">
              {/* This box is bounded by the column rather than by the graph inside
                it: React Flow measures whatever height it is given.

                The floor is what stops the two `shrink-0` rows around it from
                eating the canvas, and it yields on a short viewport rather than
                pushing the strip past the shell's clip. In a 390px-tall window
                the shell holds 364px inside its border, which a 20rem floor and
                the 44px menu bar fill exactly: the strip lands outside the clip,
                taking "Back to draft" off screen exactly where the run panel is
                most likely to be collapsed. The other term of the `min()` is
                what prevents that. It measures the viewport rather than this
                box, so it is up to 26px more generous than the shell really
                has, which costs nothing: 40% still leaves the menu bar and the
                strip more than the 76px they need at any height worth drawing a
                graph at. Whatever is left over the shell clips, which is a far
                better failure than handing React Flow a parent of zero
                height. */}
              <div className="relative min-h-[min(20rem,40dvh)] flex-1">
                <WorkflowCanvas canEdit={canUpdate} />
                {/* The agent belongs to the canvas rather than the editor shell.
                  This keeps its card above the status strip and out of the
                  properties rail while the graph remains visible behind it. */}
                {currentWorkflowId && isAgentEnabled() && (
                  <AgentPanel workflowId={currentWorkflowId} />
                )}
              </div>
              <WorkflowStatusStrip
                workflowId={currentWorkflowId ?? undefined}
              />
            </div>

            <WorkflowSidebarPanel />
          </div>
        </div>
      </div>
    </div>
  );
};

export default WorkflowEditor;
