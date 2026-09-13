/**
 * Moves the workflow's parked runs onto its current published version.
 *
 * The preview is a read the server performs with a POST, so it is held in the
 * query cache with `staleTime: 0`: every open classifies the runs again, since
 * a run that woke since the last look is no longer eligible. The dialog stays
 * mounted while it is closed, so the report of the previous open is still in
 * the cache when it reopens; the report and the confirm button are therefore
 * shown only after a successful refetch. The confirm sends every id the preview
 * called eligible in one request. The server owns the persistence-sized chunks
 * used while it reclassifies those runs before moving them.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { countBy } from "es-toolkit/array";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { orpcQuery, refreshRunHistory } from "#src/lib/rpc-query";
import {
  type MigrationOutcomeCounts,
  migrationOutcomeToast,
  migrationRefusalSentence,
  runCountLabel,
} from "#src/lib/workflow-migration-labels";
import type { WorkflowMigrationPayload } from "@wfgraph/shared/graph/migration-contracts";

/**
 * How many characters from the end of a run id name a run on screen.
 *
 * The status strip shows the same last eight characters of a run's UUIDv7, so
 * a run refused here is recognisable from the run pinned to the canvas.
 */
const RUN_ID_SUFFIX_LENGTH = 8;

/**
 * Counts one migrate call's outcomes.
 *
 * A run whose pointer moved and whose wake signal was refused is a migrated run
 * with `signaled: false`, and it is counted as `unsignaled` as well as
 * `migrated`.
 */
function migrationOutcomeCounts(
  payload: WorkflowMigrationPayload
): MigrationOutcomeCounts {
  const byStatus = countBy(payload.outcomes, (outcome) => outcome.status);
  const migrated = byStatus.migrated ?? 0;

  return {
    migrated,
    unsignaled: payload.outcomes.filter(
      (outcome) => outcome.status === "migrated" && !outcome.signaled
    ).length,
    notMoved: payload.outcomes.length - migrated,
  };
}

export function MigrationDialog({
  workflowId,
  onOpenChange,
  open,
}: {
  workflowId: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const preview = useQuery({
    ...orpcQuery.workflow.previewMigration.queryOptions({
      input: { workflowId },
    }),
    enabled: open,
    staleTime: 0,
    meta: { errorMessage: "Unable to check which runs can move" },
  });

  const migrateOptions = orpcQuery.workflow.migrateExecutions.mutationOptions({
    onSuccess: async (payload) => {
      const { title, description } = migrationOutcomeToast(
        migrationOutcomeCounts(payload)
      );
      await refreshRunHistory(queryClient);
      toast.success(title, description ? { description } : undefined);
      onOpenChange(false);
    },
    meta: { errorMessage: "Unable to migrate the runs" },
  });
  const migrate = useMutation(migrateOptions);

  // The report of the previous open survives in the cache, so it is withheld
  // until the fresh classification lands.
  const report =
    preview.isFetching || preview.isError ? undefined : preview.data;
  const eligibleCount = report?.eligible.length ?? 0;
  const isMigrating = migrate.isPending;

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!isMigrating) {
          onOpenChange(nextOpen);
        }
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton={!isMigrating}>
        <DialogHeader>
          <DialogTitle>Migrate active runs</DialogTitle>
          <DialogDescription>
            {report
              ? `Runs parked on a Wait move to version ${report.targetVersionNumber}.`
              : "Runs parked on a Wait move to the published version."}
          </DialogDescription>
        </DialogHeader>

        {preview.isFetching ? (
          <div className="min-h-28">
            <PanelState label="Checking which runs can move" />
          </div>
        ) : null}

        {preview.isError && !preview.isFetching ? (
          <div className="min-h-28">
            <PanelState
              actionLabel="Try again"
              label="Unable to check which runs can move"
              onAction={() => void preview.refetch()}
            />
          </div>
        ) : null}

        {report ? (
          <div className="overflow-hidden rounded-lg border">
            <dl className="grid grid-cols-3 gap-px bg-border">
              {[
                { label: "Ready to move", count: report.eligible.length },
                { label: "Cannot move", count: report.refused.length },
                {
                  label: `Already on version ${report.targetVersionNumber}`,
                  count: report.alreadyCurrentCount,
                },
              ].map(({ label, count }) => (
                <div className="bg-popover px-3 py-2" key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-medium tabular-nums">{count}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}

        {report && report.refused.length > 0 ? (
          <section
            aria-labelledby="migration-refused-heading"
            className="overflow-hidden rounded-lg border"
          >
            <h3
              className="border-b bg-muted/30 px-3 py-2 font-medium text-muted-foreground text-xs"
              id="migration-refused-heading"
            >
              Staying where they are
            </h3>
            <ul className="max-h-48 divide-y overflow-y-auto">
              {report.refused.map((refusal) => (
                <li className="px-3 py-2" key={refusal.executionId}>
                  <div className="flex items-baseline gap-2">
                    <span
                      className="font-mono text-xs tabular-nums"
                      title={refusal.executionId}
                    >
                      {refusal.executionId.slice(-RUN_ID_SUFFIX_LENGTH)}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {refusal.fromVersionNumber === null
                        ? "Draft"
                        : `Version ${refusal.fromVersionNumber}`}
                    </span>
                  </div>
                  <p className="mt-1 text-muted-foreground text-xs">
                    {migrationRefusalSentence(
                      refusal,
                      report.targetVersionNumber
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <DialogFooter>
          <Button
            disabled={isMigrating}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={isMigrating || eligibleCount === 0}
            onClick={() => {
              if (!report) {
                return;
              }
              migrate.mutate({
                workflowId,
                targetVersionId: report.targetVersionId,
                executionIds: report.eligible.map((item) => item.executionId),
              });
            }}
          >
            {isMigrating ? (
              <Loader2
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
              />
            ) : null}
            {isMigrating
              ? "Migrating"
              : `Migrate ${runCountLabel(eligibleCount)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
