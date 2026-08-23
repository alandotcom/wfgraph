import { useRef } from "react";
import { useSetAtom } from "jotai";
import { cn } from "@wfgraph/shared/utils";
import { useAfterCommit } from "#src/hooks/effects";
import { type ExecutionLog } from "#src/lib/execution-logs";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import {
  formatDuration,
  getStatusDotClass,
  getStatusLabel,
  getStatusTextClass,
} from "./workflow-run-shared";

export function WorkflowRunNodeIndex({
  logs,
  focusLogId,
  onFocusRestored,
  onSelect,
}: {
  logs: ExecutionLog[];
  focusLogId?: string | null;
  onFocusRestored?: () => void;
  onSelect?: (log: ExecutionLog) => void;
}) {
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  useAfterCommit(focusLogId, () => {
    if (!focusLogId) {
      return;
    }
    rowRefs.current.get(focusLogId)?.focus();
    onFocusRestored?.();
  });

  if (logs.length === 0) {
    return (
      <p className="py-4 text-muted-foreground text-xs">
        No steps were recorded for this run
      </p>
    );
  }

  const selectLog = (log: ExecutionLog) => {
    onSelect?.(log);
    setSelectedNode(log.nodeId);
  };

  return (
    <section>
      <h3 className="mb-1 font-medium text-xs/relaxed">Node journey</h3>
      <ol>
        {logs.map((log, index) => (
          <li className="relative pl-5" key={log.id}>
            {index < logs.length - 1 ? (
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
              onClick={() => selectLog(log)}
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
      </ol>
    </section>
  );
}
