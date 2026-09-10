/**
 * Every string a Migration is read by: the sentence under a refused run, and
 * the toast a migrate call ends with.
 *
 * A refusal reason arrives as a machine word, so the sentence for each reason
 * lives here rather than on the wire. `targetVersionNumber` is the version the
 * runs were asked to move to.
 */

import type { WorkflowMigrationOutcome } from "@wfgraph/shared/graph/migration-contracts";

/** One refused run, as the preview or a migrate outcome reports it. */
type MigrationRefusal = Pick<
  Extract<WorkflowMigrationOutcome, { status: "refused" }>,
  "reason" | "detail"
>;

/** "1 run" or "4 runs", for a sentence that counts runs. */
export function runCountLabel(count: number): string {
  return `${count} ${count === 1 ? "run" : "runs"}`;
}

/** One sentence saying why a run stays on the version it started with. */
export function migrationRefusalSentence(
  refusal: MigrationRefusal,
  targetVersionNumber: number
): string {
  switch (refusal.reason) {
    case "draft_run":
      return "This run is on a draft.";
    case "executing":
      return "Not parked on a Wait. Try again once the run reaches one.";
    case "wait_node_missing":
      return `The Wait this run is parked on is not in version ${targetVersionNumber}.`;
    case "node_added_above_wait":
      return `Version ${targetVersionNumber} adds a node that would run before this run's Wait.`;
    case "waits_nested":
      return `Version ${targetVersionNumber} places one of this run's Waits below another.`;
    case "unresolved_reference":
      return refusal.detail
        ? `A field below the Wait reads an output this run never produced (${refusal.detail}).`
        : "A field below the Wait reads an output this run never produced.";
    case "wait_timeout_elapsed":
      return `The Wait in version ${targetVersionNumber} would time out at once for this run.`;
    case "not_requested_version":
      return "This run moved or ended before the migration reached it.";
    default: {
      const exhaustive: never = refusal.reason;
      return exhaustive;
    }
  }
}

/**
 * What the toast says after a migrate call. A run already on the target version
 * did not move either, so it is counted in `notMoved` beside the refused runs.
 */
export function migrationOutcomeToast(counts: {
  migrated: number;
  notMoved: number;
}): { title: string; description?: string } {
  const title = `Migrated ${runCountLabel(counts.migrated)}`;
  return counts.notMoved > 0
    ? { title, description: `${runCountLabel(counts.notMoved)} did not move.` }
    : { title };
}
