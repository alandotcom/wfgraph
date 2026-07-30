/**
 * How the engine reads a value something threw.
 *
 * `@rova/shared/utils` has a richer reader that walks cause chains and SDK error
 * bodies. This one stays plain: what it produces goes into a run-log row and a
 * run's terminal record, which a builder reads, and the traversal decides a
 * run's terminal status by matching on the same text.
 */

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Whether an error escaping the traversal is the run being cancelled.
 *
 * Inngest unwinds a cancelled run by throwing, and there is no type to test
 * against, so the message is the only signal. A cancelled run is recorded as
 * cancelled rather than failed, and it is rethrown rather than swallowed into a
 * node result.
 */
export function isCancellationError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("cancel") ||
    message.includes("cancelled") ||
    message.includes("canceled")
  );
}
