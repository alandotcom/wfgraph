import { useRef } from "react";
import { cn } from "@wfgraph/shared/utils";
import { useAfterCommit } from "#src/hooks/effects";
import { type ExecutionLog } from "#src/lib/execution-logs";
import {
  formatDuration,
  getStatusDotClass,
  getStatusLabel,
  getStatusTextClass,
} from "./workflow-run-shared";

/**
 * A run's node journey: one entry per recorded node execution, in start order,
 * and the Entity eligibility exit when the run exited. Choosing an entry calls
 * `onSelect`. `focusLogId` names an entry to focus once it renders; focusing
 * keeps the scroll the journey already has, and `onFocusRestored` follows.
 */
export function WorkflowRunNodeIndex({
  logs,
  exit,
  focusLogId,
  onFocusRestored,
  onSelect,
}: {
  logs: ExecutionLog[];
  exit?: { nodeLabel: string } | undefined;
  focusLogId?: string | null | undefined;
  onFocusRestored?: (() => void) | undefined;
  onSelect: (log: ExecutionLog) => void;
}) {
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  useAfterCommit(focusLogId, () => {
    if (!focusLogId) {
      return;
    }
    rowRefs.current.get(focusLogId)?.focus({ preventScroll: true });
    onFocusRestored?.();
  });

  if (logs.length === 0 && !exit) {
    return (
      <p className="py-4 text-muted-foreground text-xs">
        No steps were recorded for this run
      </p>
    );
  }

  return (
    <section>
      <h3 className="mb-1 font-semibold text-sm">Node journey</h3>
      <ol>
        {logs.map((log, index) => (
          <li className="relative pl-5" key={log.id}>
            {index < logs.length - 1 || exit ? (
              <span
                aria-hidden="true"
                className="absolute top-4 bottom-[-1rem] left-[0.4375rem] w-px bg-border"
              />
            ) : null}
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-[1.125rem] left-1 size-2 rounded-full ring-2 ring-background",
                log.status === "running" &&
                  "ring-info/20 motion-safe:animate-pulse",
                getStatusDotClass(log.status)
              )}
            />
            <button
              aria-label={`${log.nodeName || log.nodeType}, ${getStatusLabel(log.status)}`}
              className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-2 py-1.5 text-left transition-colors duration-100 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              data-run-node-id={log.nodeId}
              data-run-log-id={log.id}
              onClick={() => onSelect(log)}
              ref={(element) => {
                if (element) {
                  rowRefs.current.set(log.id, element);
                } else {
                  rowRefs.current.delete(log.id);
                }
              }}
              type="button"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-sm">
                  {log.nodeName || log.nodeType}
                </span>
                {log.error ? (
                  <span className="block truncate text-destructive text-xs">
                    {log.error}
                  </span>
                ) : log.status === "running" ? (
                  <span className="block text-info text-xs">In progress</span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-baseline gap-2">
                <span className={cn("text-xs", getStatusTextClass(log.status))}>
                  {getStatusLabel(log.status)}
                </span>
                {log.duration ? (
                  <span className="font-mono text-muted-foreground text-xs tabular-nums">
                    {formatDuration(log.duration)}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
        {exit ? (
          <li className="relative pl-5">
            <span
              aria-hidden="true"
              className="absolute top-[1.125rem] left-1 size-2 rounded-full bg-cancelled ring-2 ring-background"
            />
            <div className="grid min-h-13 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 px-2 py-1.5">
              <span className="min-w-0">
                <span className="block truncate font-medium text-sm">
                  Entity eligibility
                </span>
                <span className="block truncate text-muted-foreground text-xs">
                  Prevented {exit.nodeLabel}
                </span>
              </span>
              <span className="text-cancelled text-xs">Exited</span>
            </div>
          </li>
        ) : null}
      </ol>
    </section>
  );
}
