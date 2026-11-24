/**
 * The `Error` a host-facing promise such as `app.events.send` rejects with
 * when its Effect failed. A domain failure gives its own sentence and `cause`.
 * A defect, such as a call after dispose, gives `fallbackMessage` with the
 * squashed cause as `cause`, so it never escapes as whatever was thrown.
 */

import { Cause, Option } from "effect";

export function hostRejection(
  cause: Cause.Cause<{ readonly error: string; readonly cause?: unknown }>,
  fallbackMessage: string
): Error {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) {
    return new Error(failure.value.error, { cause: failure.value.cause });
  }
  return new Error(fallbackMessage, { cause: Cause.squash(cause) });
}
