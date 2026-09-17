import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { toast } from "sonner";
import { AgentPanel } from "#src/components/agent/agent-panel";
import { CanvasReveal } from "#src/components/workflow/canvas-reveal/canvas-reveal";
import {
  MobileReveal,
  MobileRevealCovered,
} from "#src/components/workflow/canvas-reveal/mobile-reveal";
import { Button } from "#src/components/ui/button";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import { RunStatusProjection } from "#src/components/workflow/run-status-projection";
import { WorkflowCanvas } from "#src/components/workflow/workflow-canvas";
import { WorkflowDraftSync } from "#src/components/workflow/workflow-draft-sync";
import { WorkflowStatusStrip } from "#src/components/workflow/workflow-status-strip";
import { WorkflowToolbar } from "#src/components/workflow/workflow-toolbar";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import { useAfterCommit, useUnmountCleanup } from "#src/hooks/effects";
import { isAgentEnabled } from "#src/lib/extensions";
import { can } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { endWorkflowEditorLifetimeAtom } from "#src/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  lastSaveErrorAtom,
  workflowNotFoundAtom,
  workflowLoadErrorAtom,
} from "#src/lib/workflow-save-store";

const WorkflowEditor = () => {
  const endWorkflowEditorLifetime = useSetAtom(endWorkflowEditorLifetimeAtom);
  useUnmountCleanup(() => endWorkflowEditorLifetime());
  const lastSaveError = useAtomValue(lastSaveErrorAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
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
        {/* The editor shell: the toolbar over the canvas column. `relative`
            because the two failure overlays measure themselves against the
            whole editor.

            Three things hold the contents inside the corner, and all three are
            needed. The radius and `overflow-clip` clip an ordinary child.
            They do not clip a composited one: Canvas Reveal animates on
            `transform`, which puts it on its own layer, and a composited layer
            paints its square corner over the rounded one and takes the page
            margin's hit region with it. The
            `clip-path` is the form of the clip that layer cannot escape.

            The shell uses `overflow-clip` because a clipped box is not a scroll
            container. Focusing a control inside Canvas Reveal while Reveal
            slides in from past the right edge scrolls the nearest scroll
            container to reach it, and an `overflow-hidden` shell would be that
            container, carrying the toolbar and canvas sideways with it.

            `clip-path` rather than a transform, `contain: paint` or a mask,
            each of which would also clip a composited child: those three make
            this element the containing block for a `position: fixed`
            descendant, which would move any the editor ever holds. `clip-path`
            leaves position alone. It does clip a fixed descendant's painting
            and hit region, like everything else in here, so a popup inside the
            editor still has to be portalled out to escape the corner, which is
            what every one of them already does. */}
        <div className="relative flex size-full flex-col overflow-clip md:rounded-xl md:border md:[clip-path:inset(0_round_var(--editor-shell-radius))]">
          {/* Route → pinned-graph overlay. Outside Canvas Reveal so it
              outlives the Runs view; `RunStatusProjection` reads what it writes. */}
          <ExecutionOverlaySync />
          {/* Route → workspace address, and route recovery. After the overlay
              sync, so recovery in the same commit reads a run graph the
              overlay sync has already dropped. */}
          <WorkspaceRouteSync />
          {/* Open run → one evidence status per node, which step cards and
              Group cards both read. */}
          <RunStatusProjection />

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
          {/* The canvas column: graph in the middle, status strip below. The
              toolbar is above this column so its centred search control
              measures the editor shell. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* This box is bounded by the column rather than by the graph inside
              it: React Flow measures whatever height it is given.

              The floor is what stops the two `shrink-0` rows around it from
              eating the canvas, and it yields on a short viewport rather than
              pushing the strip past the shell's clip. The `min()` measures the
              viewport rather than this box, and whatever is left over the shell
              clips, which is a far better failure than handing React Flow a
              parent of zero height. */}
            <div className="relative min-h-[min(20rem,40dvh)] flex-1">
              <MobileRevealCovered>
                <WorkflowCanvas canEdit={canUpdate} />
                {/* The agent belongs to the canvas rather than the editor shell.
                  This keeps its card above the status strip while the graph
                  remains visible behind it. */}
                {currentWorkflowId && isAgentEnabled() && (
                  <AgentPanel workflowId={currentWorkflowId} />
                )}
              </MobileRevealCovered>
              {/* Canvas Reveal floats over the canvas, so opening it changes
                the camera's usable rectangle and never the canvas size. */}
              <CanvasReveal />
              {/* Below `md` the Draft inspector is a sequence of sheets over
                the same canvas box. */}
              <MobileReveal />
            </div>
            <WorkflowStatusStrip workflowId={currentWorkflowId ?? undefined} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default WorkflowEditor;
