/**
 * `runs` on `createWfGraphApp`, `createWfGraphRunner` and the `wfWorker`
 * config: how long run history stays in the database. The worker loop sweeps
 * with it once an hour, and a Worker on each Cron Trigger tick.
 */

/** How long run history is kept. */
export type WfGraphRunsOptions = {
  /**
   * How long an ended run is kept after it completed, in milliseconds. Absent,
   * run history is never deleted. Set, the sweep deletes each ended Execution
   * older than the window with its node logs, wait rows and timeline, the
   * workflow audit rows older than the window, and the draft snapshots no
   * Execution references. Published versions are never deleted, and a run
   * still in flight is never deleted however old it is.
   *
   * It must be an integer from one hour to 100 years, or startup refuses it.
   * A Draft run's snapshot is frozen in one transaction and pinned by the
   * insert of its Execution in a later one, and the sweep keeps a snapshot
   * reused in between only because the window is far longer than that gap.
   * Every process that runs a worker loop sweeps with its own window, so set
   * the same one in each.
   */
  retentionMs?: number | undefined;
};
