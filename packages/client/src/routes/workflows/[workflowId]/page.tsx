import { getRouteApi, Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  MobileReveal,
  MobileRevealCovered,
} from "#src/components/workflow/canvas-reveal/mobile-reveal";
import { Button } from "#src/components/ui/button";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import { RunStatusProjection } from "#src/components/workflow/run-status-projection";
import { EditorColumns } from "#src/components/workflow/columns/editor-columns";
import { DetailsColumn } from "#src/components/workflow/details/details-column";
import { WorkflowAgent } from "#src/components/agent/workflow-agent";
import { OutlineColumn } from "#src/components/workflow/outline/outline-column";
import { ReviewSheet } from "#src/components/workflow/review/review-sheet";
import { WorkflowCanvas } from "#src/components/workflow/workflow-canvas";
import { WorkflowDraftSync } from "#src/components/workflow/workflow-draft-sync";
import { WorkflowStatusStrip } from "#src/components/workflow/workflow-status-strip";
import {
  WORKSPACE_LABELS,
  WorkflowToolbar,
} from "#src/components/workflow/workflow-toolbar";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import { useDocumentTitle, useUnmountCleanup } from "#src/hooks/effects";
import { can } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { endWorkflowEditorLifetimeAtom } from "#src/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  workflowNotFoundAtom,
  workflowLoadErrorAtom,
} from "#src/lib/workflow-save-store";
import { isBlank } from "@wfgraph/shared/types/string";

const workflowRouteApi = getRouteApi("/workflows/$workflowId");

/**
 * The tab title names the workflow and the workspace view, so Back and the
 * browser's history menu tell Draft and Runs apart.
 */
function useEditorDocumentTitle(
  unavailable: "not-found" | "load-failed" | null
): void {
  const workflowName = useAtomValue(currentWorkflowNameAtom);
  const view = workflowRouteApi.useSearch({ select: (search) => search.view });
  const name = isBlank(workflowName) ? "Untitled workflow" : workflowName;
  useDocumentTitle(
    unavailable === "not-found"
      ? "Workflow not found"
      : unavailable === "load-failed"
        ? "Couldn't load workflow"
        : `${name} · ${WORKSPACE_LABELS[view ?? "draft"]}`
  );
}

/**
 * The page for a workflow id the server does not know. It draws none of the
 * editor, because a toolbar, a status strip and a canvas would describe a
 * workflow that does not exist. Its one action goes back to Workflows.
 */
function WorkflowNotFound() {
  return (
    <main className="flex h-dvh w-full items-center justify-center bg-background p-4">
      <div className="max-w-sm text-center">
        <h1 className="font-semibold text-base">Workflow not found</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          This workflow does not exist, or it was deleted.
        </p>
        <Button className="mt-4" render={<Link to="/" />}>
          Go to Workflows
        </Button>
      </div>
    </main>
  );
}

/**
 * The page for a workflow the server did not return. Like the not-found page
 * it draws none of the editor, whose title, outline, details and status strip
 * would describe a workflow that never loaded. Try again reloads the page,
 * which runs the route's load again.
 */
function WorkflowLoadFailure({ message }: { message: string }) {
  return (
    <main className="flex h-dvh w-full items-center justify-center bg-background p-4">
      <div className="max-w-sm text-center">
        <h1 className="font-semibold text-base">Couldn't load workflow</h1>
        <p className="mt-1 text-muted-foreground text-sm">{message}</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button onClick={() => window.location.reload()}>Try again</Button>
          <Button render={<Link to="/" />} variant="outline">
            Go to Workflows
          </Button>
        </div>
      </div>
    </main>
  );
}

const WorkflowEditor = () => {
  const endWorkflowEditorLifetime = useSetAtom(endWorkflowEditorLifetimeAtom);
  useUnmountCleanup(() => endWorkflowEditorLifetime());
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const workflowNotFound = useAtomValue(workflowNotFoundAtom);
  const workflowLoadError = useAtomValue(workflowLoadErrorAtom);
  const canUpdate = can(WfGraphOperations.workflowUpdate.id);
  useEditorDocumentTitle(
    workflowNotFound ? "not-found" : workflowLoadError ? "load-failed" : null
  );

  if (workflowNotFound) {
    return <WorkflowNotFound />;
  }
  if (workflowLoadError) {
    return <WorkflowLoadFailure message={workflowLoadError} />;
  }

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
        {/* The editor shell: the toolbar over the canvas column.

            Three things hold the contents inside the corner, and all three are
            needed. The radius and `overflow-clip` clip an ordinary child.
            They do not clip a composited one: a phone sheet animates on
            `transform`, which puts it on its own layer, and a composited layer
            paints its square corner over the rounded one and takes the page
            margin's hit region with it. The
            `clip-path` is the form of the clip that layer cannot escape.

            The shell uses `overflow-clip` because a clipped box is not a scroll
            container. Focusing a control inside a sheet while it slides in
            from past an edge scrolls the nearest scroll
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
          {/* Route → pinned-graph overlay. Outside the details column so it
              outlives the Runs view; `RunStatusProjection` reads what it writes. */}
          <ExecutionOverlaySync />
          {/* Route → workspace address, and route recovery. After the overlay
              sync, so recovery in the same commit reads a run graph the
              overlay sync has already dropped. */}
          <WorkspaceRouteSync />
          {/* Open run → one evidence status per node, which step cards and
              Group cards both read. */}
          <RunStatusProjection />

          {currentWorkflowId && (
            <WorkflowDraftSync workflowId={currentWorkflowId} />
          )}

          <WorkflowToolbar workflowId={currentWorkflowId ?? undefined} />
          {/* The columns, with the status strip below. The toolbar is above
              this column so its centred search control measures the editor
              shell. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <EditorColumns
              canvas={
                <MobileRevealCovered>
                  <WorkflowCanvas canEdit={canUpdate} />
                </MobileRevealCovered>
              }
              composer={<WorkflowAgent />}
              details={<DetailsColumn />}
              outline={<OutlineColumn />}
              phone={
                // Below `md` details are a sequence of sheets over the outline
                // or the canvas.
                <MobileReveal />
              }
              overlay={
                // The review sheet covers the details column and reaches over
                // the canvas while it is open, and covers the screen below
                // `md`.
                <ReviewSheet />
              }
            />
            <WorkflowStatusStrip workflowId={currentWorkflowId ?? undefined} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default WorkflowEditor;
