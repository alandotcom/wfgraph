import { Ban } from "lucide-react";
import type { RefusedStart } from "#src/lib/execution-logs";

/**
 * The Refused Starts: arrivals this workflow declined, which have no run to be
 * listed under.
 *
 * A refusal writes an audit row and no execution row -- first-wins Concurrency
 * found a run for the entity already going, the payload carried nothing at the
 * Correlation Path Concurrency needs, or a manual start is not allowed here -- and
 * without this the only trace was the server log, which is the class of invisible
 * behaviour ADR-0007 exists to remove.
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
            <p className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {refusal.createdAt.toLocaleTimeString()}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
