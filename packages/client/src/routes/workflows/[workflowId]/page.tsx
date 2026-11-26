import { getRouteApi, Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  MobileReveal,
  MobileRevealCovered,
} from "#src/components/workflow/canvas-reveal/mobile-reveal";
import { Button } from "#src/components/ui/button";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import { RunStatusProjection } from "#src/components/workflow/run-status-projection";
import { EditorLayout } from "#src/components/workflow/columns/editor-layout";
import { EditorShell } from "#src/components/workflow/columns/editor-shell";
import { DetailsPanel } from "#src/components/workflow/details/details-panel";
import { WorkflowAgent } from "#src/components/agent/workflow-agent";
import { OutlineColumn } from "#src/components/workflow/outline/outline-column";
import { RunStoppedStepSelection } from "#src/components/workflow/outline/run-stopped-step";
import { ReviewSheet } from "#src/components/workflow/review/review-sheet";
import { WorkflowCanvas } from "#src/components/workflow/workflow-canvas";
import { WorkflowDraftSync } from "#src/components/workflow/workflow-draft-sync";
import { WorkflowStatusStrip } from "#src/components/workflow/workflow-status-strip";
import {
  WORKSPACE_LABELS,
  WorkflowToolbar,
} from "#src/components/workflow/workflow-toolbar";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import {
  useAfterPaint,
  useDocumentTitle,
  useUnmountCleanup,
} from "#src/hooks/effects";
import { focusOutlineCurrentRow } from "#src/components/workflow/step-focus-landing";
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
  // Opening a workflow unmounts the control that opened it, which leaves
  // focus on the page body; it lands on the outline's first row instead.
  useAfterPaint(currentWorkflowId, () => {
    if (document.activeElement === document.body) {
      focusOutlineCurrentRow();
    }
  });
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
    <EditorShell>
      {/* Route → pinned-graph overlay. Outside the Inspector so it outlives
          the Runs view; `RunStatusProjection` reads what it writes. */}
      <ExecutionOverlaySync />
      {/* Route → workspace address, and route recovery. After the overlay
          sync, so recovery in the same commit reads a run graph the overlay
          sync has already dropped. */}
      <WorkspaceRouteSync />
      {/* Open run → one evidence status per node, which step cards and Group
          cards both read. */}
      <RunStatusProjection />
      {/* A failed or waiting run opens on the step it stopped at. */}
      <RunStoppedStepSelection />

      {currentWorkflowId && (
        <WorkflowDraftSync workflowId={currentWorkflowId} />
      )}

      <WorkflowToolbar workflowId={currentWorkflowId ?? undefined} />
      {/* The canvas with what floats over it, and the status strip below. The
          toolbar is above this column so its centred search control measures
          the editor shell. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <EditorLayout
          canvas={
            <MobileRevealCovered>
              <WorkflowCanvas />
            </MobileRevealCovered>
          }
          composer={<WorkflowAgent />}
          details={<DetailsPanel />}
          outline={<OutlineColumn />}
          phone={
            // Below `md` details are a sequence of sheets over the outline
            // or the canvas.
            <MobileReveal />
          }
          overlay={
            // The review sheet reaches over the canvas and the Inspector from
            // the editor's right edge while it is open, and covers the screen
            // below `md`.
            <ReviewSheet />
          }
        />
        <WorkflowStatusStrip workflowId={currentWorkflowId ?? undefined} />
      </div>
    </EditorShell>
  );
};

export default WorkflowEditor;
