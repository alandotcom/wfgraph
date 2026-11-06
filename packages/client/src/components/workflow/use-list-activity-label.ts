import { useNowMs } from "#src/hooks/effects";
import {
  type ListActivity,
  type ListActivityLabel,
  listActivityLabel,
} from "#src/lib/run-executor-activity";

/**
 * What one runs list row says about `activity`, as `listActivityLabel` words
 * it. A row that is unclaimed re-renders once a second so its wait keeps
 * counting between fetches; every other row reads the clock once.
 */
export function useListActivityLabel(
  activity: ListActivity | null,
  /** The browser's clock when the row's page arrived, or null when unknown. */
  receivedAtMs: number | null
): ListActivityLabel | null {
  const nowMs = useNowMs({
    intervalMs: 1000,
    enabled: activity?.kind === "unclaimed" && receivedAtMs !== null,
  });
  return listActivityLabel({ activity, receivedAtMs, nowMs });
}
