/**
 * The Lifecycle Node's outlets, named where both sides can read them.
 *
 * The editor draws edges from a handle carrying this id and the save refuses an
 * edge from the entry node that names none, so the string has one owner. The
 * Canceled outlet joins it in stage 7, which is the whole reason an edge has to
 * name which one it left: with two handles, an unnamed edge binds by render order.
 */
export const LIFECYCLE_STARTED_HANDLE = "started";
