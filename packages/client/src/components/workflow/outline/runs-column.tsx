import { useAtomValue, useStore } from "jotai";
import { ArrowLeft } from "lucide-react";
import { useRef, useState } from "react";
import { DeleteConfirmDialog } from "#src/components/delete-confirm-dialog";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { useOpenRunList } from "#src/components/workflow/canvas-reveal/runs-browse";
import { useAddressBodyScroll } from "#src/components/workflow/canvas-reveal/use-address-body-scroll";
import { ColumnHeader } from "#src/components/workflow/columns/editor-columns";
import {
  type ConfirmRequest,
  RunsListActions,
} from "#src/components/workflow/node-config-panel";
import { useWorkflowRuns } from "#src/components/workflow/use-workflow-runs";
import {
  runStatusLabel,
  runStatusTone,
  statusToneTextClass,
} from "#src/components/workflow/workflow-run-shared";
import { runTitle } from "#src/components/workflow/workflow-run-summary-row";
import {
  RunsEmptyState,
  RunsListNotices,
  RunsLoadFailure,
  RunsSkeleton,
  RunUnavailableMessage,
} from "#src/components/workflow/workflow-runs";
import { WorkflowRunsList } from "#src/components/workflow/workflow-runs-list";
import { useAfterCommit, useDomEvent } from "#src/hooks/effects";
import { editorChordAllowed } from "#src/lib/editor-shortcuts";
import type { ExecutionLog } from "#src/lib/execution-logs";
import { testRunSkip } from "#src/lib/test-run-skip";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  inspectRunNodeAtom,
} from "#src/lib/workflow-workspace-navigation";
import { cn } from "@wfgraph/shared/utils";
import { WorkflowOutline } from "./workflow-outline";

/**
 * The left column in Runs. With no run open it lists the workflow's runs,
 * newest first, each named by its Entity, with Refresh and "Delete all runs".
 * With a run open it is that run's outline under a header naming the run, with
 * Back to the list; J and K open the next and previous run in the list. A run
 * that failed or is waiting opens with the step it stopped at selected, so its
 * reason and its action are already in the details column.
 */
export function RunsColumn() {
  const runs = useWorkflowRuns();
  const catalog = useExtensionCatalog();
  const openRunList = useOpenRunList();
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const { screen } = runs;
  const openRun = screen.kind === "run" ? screen.run.execution : null;

  useSelectStoppedStep(openRun);

  useDomEvent(document, "keydown", (event) => {
    const key = event.key.toLowerCase();
    if (
      openRun === null ||
      (key !== "j" && key !== "k") ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      !editorChordAllowed(event, { inTextFields: false })
    ) {
      return;
    }
    const index = runs.listedRuns.findIndex((run) => run.id === openRun.id);
    // The list is newest first, so J moves down it to an older run.
    const next = runs.listedRuns[key === "j" ? index + 1 : index - 1];
    if (index >= 0 && next) {
      event.preventDefault();
      runs.selectRun(next.id);
    }
  });

  const listShown = screen.kind === "list" || screen.kind === "list-error";
  const loadingList = screen.kind === "loading-list";
  const address = useAtomValue(activeWorkspaceAddressAtom);
  // The list keeps its scroll per address, so Back from a run returns to it.
  const {
    ref: listScrollRef,
    onScroll,
    onScrollEnd,
    adoptScroll,
  } = useAddressBodyScroll(screen.kind === "list" ? address : null, null);

  // A focused row has scrolled the list to itself, and that position replaces
  // the stored one. With the row gone, the details column's title takes focus.
  const answerRowFocus = (focused: boolean) => {
    runs.clearRowFocus();
    if (focused) {
      adoptScroll();
      return;
    }
    document
      .querySelector<HTMLElement>(
        '[data-slot="details-panel"] [data-slot="reveal-title"], [data-slot="mobile-reveal"] [data-slot="reveal-title"]'
      )
      ?.focus();
  };

  return (
    <>
      <ColumnHeader side="outline">
        {listShown || loadingList ? (
          <>
            <h2 className="min-w-0 flex-1 truncate font-medium text-sm">
              Runs
            </h2>
            <RunsListActions confirm={setRequest} />
          </>
        ) : (
          <>
            <Button
              aria-label="Back to runs"
              onClick={openRunList}
              size="icon-sm"
              title="Back to runs"
              type="button"
              variant="ghost"
            >
              <ArrowLeft />
            </Button>
            <h2 className="min-w-0 flex-1 truncate font-medium text-sm">
              {openRun ? runTitle(openRun, catalog) : "Run"}
            </h2>
            {openRun ? (
              <span
                className={cn(
                  "shrink-0 text-xs",
                  statusToneTextClass(runStatusTone(openRun.status))
                )}
              >
                {runStatusLabel(openRun.status)}
              </span>
            ) : null}
          </>
        )}
      </ColumnHeader>
      {openRun?.versionKind === "published" &&
      openRun.versionNumber !== null ? (
        // Each version numbers its own steps, so a run of an earlier version
        // can number a step differently from the draft.
        <p
          className="shrink-0 border-b px-3 py-1.5 text-muted-foreground text-xs"
          data-slot="run-steps-version"
        >
          Steps as of v{openRun.versionNumber}, so a number can differ from the
          draft.
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col" data-slot="runs-column">
        {loadingList ? <RunsSkeleton /> : null}
        {screen.kind === "run-unavailable" ? (
          <RunUnavailableMessage retry={screen.retry} />
        ) : null}
        {screen.kind === "list-error" ? (
          <RunsLoadFailure retry={screen.retry} />
        ) : null}
        {screen.kind === "list" ? (
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1"
            data-slot="runs-list-scroller"
            onScroll={onScroll}
            onScrollEnd={onScrollEnd}
            ref={listScrollRef}
          >
            <div className="px-2 py-2">
              <RunsListNotices runs={runs}>
                {screen.executions.length === 0 ? <RunsEmptyState /> : null}
              </RunsListNotices>
            </div>
            <WorkflowRunsList
              executions={screen.executions}
              focusId={runs.focusRunId}
              onFocusAnswered={answerRowFocus}
              onSelect={runs.selectRun}
              receivedAtMs={screen.receivedAtMs}
            />
          </div>
        ) : null}
        {screen.kind === "run" && screen.pinnedGraph === "unavailable" ? (
          <p className="px-3 py-3 text-muted-foreground text-sm">
            The graph this run used could not be loaded, so its steps cannot be
            listed.
          </p>
        ) : null}
        {screen.kind === "run" && screen.pinnedGraph === "ready" ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <WorkflowOutline
              openRun={{
                waits: screen.run.waits,
                testSkipped: testSkippedNodeIds(screen.run),
              }}
            />
          </div>
        ) : null}
      </div>
      <DeleteConfirmDialog
        confirmLabel={request?.confirmLabel}
        description={request?.message}
        onConfirm={() => request?.onConfirm()}
        onOpenChange={(open) => {
          if (!open) setRequest(null);
        }}
        open={request !== null}
        title={request?.title}
      />
    </>
  );
}

/**
 * The steps whose latest execution did nothing because the run has Test
 * recipients, as the canvas chip reads them.
 */
function testSkippedNodeIds(run: {
  execution: { runMode: "live" | "test" };
  logs: readonly ExecutionLog[];
}): ReadonlySet<string> {
  return new Set(
    run.logs
      .filter(
        (log) =>
          testRunSkip({
            runMode: run.execution.runMode,
            status: log.status,
            output: log.output,
          }) !== null
      )
      .map((log) => log.nodeId)
  );
}

/**
 * Select the step an opening run stopped at, once per run: the step that
 * failed in a failed run, or the Wait a waiting run is parked on, with its
 * evidence in the details column. The canvas already places that step in
 * view when the run opens, so this asks for no camera move. A run that has
 * a selection, or that ended any other way, opens as it is.
 */
function useSelectStoppedStep(
  openRun: { id: string; status: string } | null
): void {
  const store = useStore();
  const overlay = useAtomValue(executionOverlayGraphAtom);
  const handledRunId = useRef<string | null>(null);
  const stoppedNodeId = overlay?.stoppedNodeId ?? null;
  const key =
    openRun === null || overlay === null
      ? null
      : `${openRun.id}|${openRun.status}|${stoppedNodeId ?? ""}`;
  useAfterCommit(key, () => {
    if (openRun === null || overlay === null) return;
    if (handledRunId.current === openRun.id) return;
    if (openRun.status !== "failed" && openRun.status !== "waiting") {
      // A run still running may yet stop; one that ended never will.
      if (openRun.status !== "running") {
        handledRunId.current = openRun.id;
      }
      return;
    }
    if (stoppedNodeId === null) return;
    handledRunId.current = openRun.id;
    if (store.get(activeSelectionAtom).nodeIds.length > 0) return;
    store.set(inspectRunNodeAtom, {
      address: store.get(activeWorkspaceAddressAtom),
      nodeId: stoppedNodeId,
      executionLogId: null,
      selectsNode: true,
      opensFocus: true,
    });
  });
}
