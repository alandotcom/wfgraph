import { Ban } from "lucide-react";
import type { RefusedStart } from "#src/lib/execution-logs";
import { getRelativeTime } from "@wfgraph/shared/utils/time";

/**
 * The Refused Starts: arrivals this workflow declined, which have no run to be
 * listed under.
 *
 * A refusal writes a `run_refused` audit row and no execution row. First-wins
 * Concurrency can find a run for the entity already going, the payload can lack
 * the Correlation Path value Concurrency needs, a manual start can be refused,
 * or the Start Filter can decline the arrival. A cancellation delivery failure
 * uses `cancel_not_delivered` and renders under Cancellation Failures.
 *
 * The rows arrive with the runs they belong beside, so this renders and reads
 * nothing of its own.
 */
export function WorkflowRefusedStarts({
  refusedStarts,
}: {
  refusedStarts: RefusedStart[];
}) {
  if (refusedStarts.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <Ban className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="font-medium text-sm">Refused Starts</p>
      </div>
      <div className="divide-y">
        {refusedStarts.map((refusal) => (
          <div
            className="flex items-start justify-between gap-3 py-2"
            key={refusal.id}
          >
            <p className="text-foreground text-xs">{refusal.message}</p>
            {/* Relative, like the runs listed under this block: refusals are
                not capped to today, and a bare clock time reads as recent for
                one that happened last week. */}
            <p
              className="shrink-0 text-muted-foreground text-xs tabular-nums"
              title={refusal.createdAt.toLocaleString()}
            >
              {getRelativeTime(refusal.createdAt)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
