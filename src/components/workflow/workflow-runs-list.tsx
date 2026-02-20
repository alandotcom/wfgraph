import { cn } from "@/shared/utils";
import { getRelativeTime } from "@/shared/utils/time";
import {
  formatDuration,
  getStatusBadgeClass,
  getStatusDotClass,
  getStatusLabel,
  type WorkflowExecution,
} from "./workflow-run-shared";

type WorkflowRunsListProps = {
  executions: WorkflowExecution[];
  selectedId: string | null;
  onSelect: (executionId: string) => void;
};

export function WorkflowRunsList({
  executions,
  selectedId,
  onSelect,
}: WorkflowRunsListProps) {
  return (
    <div className="divide-y">
      {executions.map((execution, index) => {
        const isSelected = selectedId === execution.id;
        const runNumber = executions.length - index;

        return (
          <button
            className={cn(
              "flex w-full items-center gap-3 px-1 py-3 text-left transition-colors hover:bg-muted/50",
              isSelected && "bg-muted/50"
            )}
            key={execution.id}
            onClick={() => onSelect(execution.id)}
            type="button"
          >
            {/* Status dot */}
            <div
              className={cn(
                "size-2.5 shrink-0 rounded-full",
                getStatusDotClass(execution.status)
              )}
            />

            {/* Content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">Run #{runNumber}</span>
                <span
                  className={cn(
                    "rounded border px-1.5 py-0.5 font-medium text-[10px] uppercase",
                    getStatusBadgeClass(execution.status)
                  )}
                >
                  {getStatusLabel(execution.status)}
                </span>
                {execution.isDryRun ? (
                  <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-medium text-[10px] text-amber-700 uppercase dark:text-amber-300">
                    Dry Run
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-muted-foreground text-xs">
                <span>{getRelativeTime(execution.startedAt)}</span>
                {execution.triggerType ? (
                  <>
                    <span>·</span>
                    <span className="capitalize">{execution.triggerType}</span>
                  </>
                ) : null}
                {execution.duration ? (
                  <>
                    <span>·</span>
                    <span className="font-mono tabular-nums">
                      {formatDuration(execution.duration)}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
