import { CircleX } from "lucide-react";
import type { CancelNotDelivered } from "#src/lib/execution-logs";
import { getRelativeTime } from "@wfgraph/shared/utils/time";

/**
 * Cancellation failures: Cancel Events that reached no run. Missing Entity
 * Values and declined or unevaluable Cancel Filters produce these audit rows.
 * The Runs panel renders them separately from Refused Starts.
 */
export function WorkflowCancellationFailures({
  cancelNotDelivered,
}: {
  cancelNotDelivered: CancelNotDelivered[];
}) {
  if (cancelNotDelivered.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <CircleX className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="font-medium text-sm">Cancellation Failures</p>
      </div>
      <div className="divide-y">
        {cancelNotDelivered.map((failure) => (
          <div
            className="flex items-start justify-between gap-3 py-2"
            key={failure.id}
          >
            <p className="text-foreground text-xs">{failure.message}</p>
            <p
              className="shrink-0 text-muted-foreground text-xs tabular-nums"
              title={failure.createdAt.toLocaleString()}
            >
              {getRelativeTime(failure.createdAt)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
