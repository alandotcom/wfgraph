import { useNowMs } from "#src/hooks/effects";
import {
  type ListActivity,
  listServerNowMs,
} from "#src/lib/run-executor-activity";

/**
 * The server's clock for a runs list, as `listServerNowMs` estimates it,
 * ticking once a second while a row is unclaimed so its wait keeps counting
 * between fetches. Null when no row is unclaimed.
 */
export function useRunListClock(input: {
  activities: ReadonlyArray<ListActivity | null>;
  /** The browser's clock when the list's data arrived. */
  receivedAtMs: number;
}): number | null {
  const nowMs = useNowMs({
    intervalMs: 1000,
    enabled: input.activities.some(
      (activity) => activity?.kind === "unclaimed"
    ),
  });
  return listServerNowMs({ ...input, nowMs });
}
