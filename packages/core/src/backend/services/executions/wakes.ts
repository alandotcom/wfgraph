/**
 * Where `ExecutionDriver` announces that a committed write made schedule rows
 * due. Each sink reaches some set of worker loops: the loop in this process,
 * the loops in other processes on the same database, or a platform queue that
 * starts a tick. A sink returns at once, and a wake it loses costs at most one
 * poll interval of the loop it would have reached.
 */
export type RunWakeSink = {
  /** Notes that schedule rows fell due. The note names no row. */
  readonly announce: () => void;
};
