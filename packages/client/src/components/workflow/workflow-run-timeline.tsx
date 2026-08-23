import { useSetAtom } from "jotai";
import { cn } from "@wfgraph/shared/utils";
import { type ExecutionLog } from "#src/lib/execution-logs";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import {
  formatDuration,
  getStatusLabel,
  getStatusTextClass,
} from "./workflow-run-shared";

export function WorkflowRunNodeIndex({ logs }: { logs: ExecutionLog[] }) {
  const setSelectedNode = useSetAtom(selectedNodeAtom);

  if (logs.length === 0) {
    return (
      <p className="py-4 text-muted-foreground text-xs">No steps recorded</p>
    );
  }

  return (
    <div>
      <h3 className="mb-1 font-medium text-xs/relaxed">Nodes</h3>
      {logs.map((log) => (
        <button
          className="flex w-full items-baseline gap-2 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          key={log.id}
          onClick={() => setSelectedNode(log.nodeId)}
          type="button"
        >
          <span className="min-w-0 flex-1 font-medium text-sm">
            {log.nodeName || log.nodeType}
          </span>
          <span
            className={cn("shrink-0 text-xs", getStatusTextClass(log.status))}
          >
            {getStatusLabel(log.status)}
          </span>
          {log.duration ? (
            <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
              {formatDuration(log.duration)}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
