import { useAtomValue } from "jotai";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { DeleteConfirmDialog } from "#src/components/delete-confirm-dialog";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { useOpenRunList } from "#src/components/workflow/canvas-reveal/runs-browse";
import { useAddressBodyScroll } from "#src/components/workflow/canvas-reveal/use-address-body-scroll";
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
import { useDomEvent } from "#src/hooks/effects";
import { editorChordAllowed } from "#src/lib/editor-shortcuts";
import type { ExecutionLog } from "#src/lib/execution-logs";
import { testRunSkip } from "#src/lib/test-run-skip";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import { cn } from "@wfgraph/shared/utils";
import { WorkflowOutline } from "./workflow-outline";

/**
 * The outline in Runs. With no run open it lists the workflow's runs,
 * newest first, each named by its Entity, with Refresh and "Delete all runs".
 * With a run open it is that run's outline under a header naming the run, with
 * Back to the list; J and K open the next and previous run in the list.
 */
export function RunsColumn() {
  const runs = useWorkflowRuns();
  const catalog = useExtensionCatalog();
  const openRunList = useOpenRunList();
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const { screen } = runs;
  const openRun = screen.kind === "run" ? screen.run.execution : null;

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
  // the stored one. With the row gone, the Inspector's title takes focus.
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
      ?.focus({ preventScroll: true });
  };

  return (
    <>
      <div
        className="flex h-9 shrink-0 items-center gap-2 px-2"
        data-slot="runs-header"
      >
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
      </div>
      {openRun?.versionKind === "published" &&
      openRun.versionNumber !== null ? (
        // Each version numbers its own steps, so a run of an earlier version
        // can number a step differently from the draft.
        <p
          className="shrink-0 px-2 py-1 text-muted-foreground text-xs"
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
            // The rows float over the canvas like the outline's, so each is
            // marked by its fill alone, with no rule between them.
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 [&_button[data-testid=workflow-run-summary-row]]:rounded-md [&_button[data-testid=workflow-run-summary-row]]:border-b-0"
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
