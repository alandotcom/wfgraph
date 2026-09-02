import { useInfiniteQuery } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "#src/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#src/components/ui/dialog";
import { PanelState } from "#src/components/workflow/workflow-changes-panel-state";
import { WorkflowVersionUsage } from "#src/components/workflow/workflow-version-usage";
import {
  comparisonSessionAtom,
  setComparisonSubviewAtom,
} from "#src/lib/workflow-comparison-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { orpcQuery } from "#src/lib/rpc-query";
import { can } from "#src/lib/authorization";
import type { WorkflowVersionCursor } from "@wfgraph/shared/graph/publication-contracts";
import { cn } from "@wfgraph/shared/utils";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { useWorkflowComparisonActions } from "#src/components/workflow/use-workflow-comparison-actions";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

type WorkflowComparisonActions = ReturnType<
  typeof useWorkflowComparisonActions
>;

export function WorkflowVersionHistory({
  actions,
}: {
  actions: WorkflowComparisonActions;
}) {
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const session = useAtomValue(comparisonSessionAtom);
  const setSubview = useSetAtom(setComparisonSubviewAtom);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const canReadHistory = can(WfGraphOperations.workflowGetVersionHistory.id);
  const canReadUsage = can(WfGraphOperations.workflowGetVersionUsage.id);

  const history = useInfiniteQuery({
    ...orpcQuery.workflow.getVersionHistory.infiniteOptions({
      // The contract declares `cursor` as an optional key, so the first page
      // omits it instead of sending `undefined`.
      input: (cursor: WorkflowVersionCursor | undefined) =>
        omitUndefined({
          workflowId: workflowId ?? "",
          cursor,
        }),
      initialPageParam: undefined as WorkflowVersionCursor | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      enabled: Boolean(
        workflowId && session?.subview === "history" && canReadHistory
      ),
      meta: { errorMessage: "Unable to load version history" },
    }),
  });
  const historyItems = useMemo(
    () => history.data?.pages.flatMap((page) => page.items) ?? [],
    [history.data]
  );
  const selectedHistory = historyItems.find(
    (item) => item.id === session?.selectedHistoryVersionId
  );

  if (!session) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="version-history">
      <div className="flex items-center gap-2 border-b p-3">
        <Button
          aria-label="Back to changes"
          onClick={() =>
            workflowId && setSubview({ workflowId, subview: "review" })
          }
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ArrowLeft />
        </Button>
        <h2 className="font-semibold text-sm">Version history</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {canReadUsage && workflowId ? (
          <WorkflowVersionUsage workflowId={workflowId} />
        ) : null}
        <section aria-labelledby="all-versions-heading">
          <div className="border-b bg-muted/30 px-4 py-2">
            <h3
              className="font-medium text-muted-foreground text-xs"
              id="all-versions-heading"
            >
              All versions
            </h3>
          </div>
          {history.isPending ? (
            <div className="min-h-28">
              <PanelState label="Loading version history" />
            </div>
          ) : null}
          {history.isError ? (
            <div className="min-h-28">
              <PanelState label="Unable to load version history" />
            </div>
          ) : null}
          {!history.isPending && !history.isError ? (
            <div className="divide-y">
              {historyItems.map((item) => (
                <button
                  aria-pressed={item.id === session.selectedHistoryVersionId}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted",
                    item.id === session.selectedHistoryVersionId && "bg-muted"
                  )}
                  key={item.id}
                  disabled={actions.isPending}
                  onClick={() => {
                    if (!workflowId) return;
                    void actions.openComparison({
                      baseVersionId: item.id,
                    });
                  }}
                  type="button"
                >
                  <span className="font-medium text-xs">
                    Version {item.version}
                  </span>
                  <span className="text-right text-muted-foreground text-xs">
                    {item.isCurrent ? "Current" : ""}
                    {item.isCurrent ? " · " : ""}
                    {new Date(item.publishedAt).toLocaleString()}
                  </span>
                </button>
              ))}
              {history.hasNextPage ? (
                <div className="p-3">
                  <Button
                    className="w-full"
                    disabled={history.isFetchingNextPage}
                    onClick={() => void history.fetchNextPage()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {history.isFetchingNextPage ? "Loading" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
      {actions.canRestore ? (
        <div className="border-t p-3">
          <Button
            className="w-full"
            disabled={!selectedHistory || actions.restore.isPending}
            onClick={() => setRestoreOpen(true)}
            type="button"
            variant="outline"
          >
            <RotateCcw data-icon="inline-start" />
            Restore{" "}
            {selectedHistory
              ? `version ${selectedHistory.version}`
              : "version"}{" "}
            as draft
          </Button>
        </div>
      ) : null}
      {actions.canRestore && selectedHistory ? (
        <RestoreDialog
          isPending={actions.restore.isPending}
          onOpenChange={setRestoreOpen}
          onRestore={() =>
            actions.canRestore &&
            workflowId &&
            actions.restore.mutate({
              workflowId,
              versionId: selectedHistory.id,
            })
          }
          open={restoreOpen}
          version={selectedHistory.version}
        />
      ) : null}
    </div>
  );
}

function RestoreDialog({
  version,
  open,
  isPending,
  onOpenChange,
  onRestore,
}: {
  version: number;
  open: boolean;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onRestore: () => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent showCloseButton={!isPending}>
        <DialogHeader>
          <DialogTitle>Restore version {version} as draft?</DialogTitle>
          <DialogDescription>
            This replaces the current draft with version {version}. The current
            published version remains unchanged until a later publish.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            disabled={isPending}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={isPending} onClick={onRestore} type="button">
            {isPending ? "Restoring" : "Restore as draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
