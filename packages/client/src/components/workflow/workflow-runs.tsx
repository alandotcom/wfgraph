import { type ReactNode } from "react";
import { Button } from "#src/components/ui/button";
import { WorkflowCancellationFailures } from "./workflow-cancellation-failures";
import { WorkflowRefusedStarts } from "./workflow-refused-starts";
import type { WorkflowRunsState } from "./use-workflow-runs";

/**
 * The row cap the server reads under, mirrored here for one sentence only: past
 * this many superseded runs, showing them cannot show them all, and a label that
 * promised otherwise would be a lie a builder could count.
 */
const EXECUTIONS_PAGE_CAP = 50;

export function RunsSkeleton({ detail = false }: { detail?: boolean }) {
  return (
    <div
      aria-label="Loading runs"
      aria-busy="true"
      className="flex h-full min-h-0 flex-col"
    >
      <div className="shrink-0 space-y-2 border-b px-3 py-3">
        <div className="h-4 w-2/3 rounded-sm bg-muted" />
        <div className="h-3 w-1/2 rounded-sm bg-muted" />
        {detail ? <div className="mt-3 h-16 rounded-sm bg-muted/70" /> : null}
      </div>
      <div className="min-h-0 flex-1 px-3 py-2">
        {Array.from({ length: detail ? 4 : 6 }, (_, index) => (
          <div className="flex h-13 items-center gap-3 border-b" key={index}>
            <div className="size-2 rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-2/3 rounded-sm bg-muted" />
              <div className="h-2.5 w-1/2 rounded-sm bg-muted/70" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The run list failed to load, with a Retry that reads it again. */
export function RunsLoadFailure({ retry }: { retry: () => void }) {
  return (
    <div className="p-3">
      <p className="text-muted-foreground text-sm">Runs could not be loaded.</p>
      <Button
        className="mt-2"
        onClick={retry}
        size="sm"
        type="button"
        variant="outline"
      >
        Retry
      </Button>
    </div>
  );
}

/** The run the route names could not be read, with a Retry. */
export function RunUnavailableMessage({ retry }: { retry: () => void }) {
  return (
    <div className="p-3">
      <p className="text-muted-foreground text-sm">
        This run could not be loaded.
      </p>
      <Button
        className="mt-2"
        onClick={retry}
        size="sm"
        type="button"
        variant="outline"
      >
        Retry
      </Button>
    </div>
  );
}

/**
 * What sits above the run rows: the superseded count and its Show or Hide, the
 * Refused Starts, and the Cancellation Failures, followed by `children`.
 */
export function RunsListNotices({
  runs,
  children,
}: {
  runs: WorkflowRunsState;
  children?: ReactNode;
}) {
  const { supersededCount } = runs;
  return (
    <div className="space-y-2">
      {supersededCount > 0 ? (
        <div className="flex items-center justify-between gap-2 border-b px-1 pb-2">
          <p className="text-muted-foreground text-xs">
            {supersededCount === 1
              ? "1 run was superseded by a newer start"
              : `${supersededCount} runs were superseded by newer starts`}
            {supersededCount > EXECUTIONS_PAGE_CAP
              ? `, of which the newest ${EXECUTIONS_PAGE_CAP} can be shown`
              : ""}
          </p>
          <Button
            onClick={runs.toggleSuperseded}
            size="sm"
            type="button"
            variant="ghost"
          >
            {runs.showSuperseded ? "Hide" : "Show"}
          </Button>
        </div>
      ) : null}
      <WorkflowRefusedStarts refusedStarts={runs.refusedStarts} />
      <WorkflowCancellationFailures
        cancelNotDelivered={runs.cancelNotDelivered}
      />
      {children}
    </div>
  );
}

export function RunsEmptyState() {
  return (
    <div className="py-8 text-center">
      <p className="font-medium text-sm">No runs yet</p>
      <p className="mt-1 text-muted-foreground text-xs">
        Runs appear after this workflow starts.
      </p>
    </div>
  );
}
