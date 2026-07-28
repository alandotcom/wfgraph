import { useState } from "react";
import { cn } from "@rova/shared/utils";
import { type ExecutionLog } from "#src/lib/execution-logs";
import {
  CollapsibleSection,
  formatDuration,
  getStatusDotClass,
  getStatusLabel,
  JsonWithLinks,
  OutputDisplay,
} from "./workflow-run-shared";

function TimelineEntry({
  log,
  isLast,
}: {
  log: ExecutionLog;
  isLast: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="relative flex gap-3">
      {/* Vertical connecting line */}
      {isLast ? null : (
        <div className="absolute top-5 bottom-0 left-[7px] w-px bg-border" />
      )}

      {/* Status dot */}
      <div className="relative z-10 mt-1.5 flex shrink-0 items-center justify-center">
        <div
          className={cn(
            "size-[15px] rounded-full ring-2 ring-background",
            getStatusDotClass(log.status)
          )}
        />
      </div>

      {/* Step content */}
      <div className="min-w-0 flex-1 pb-4">
        <button
          className="group w-full text-left"
          onClick={() => setIsExpanded(!isExpanded)}
          type="button"
        >
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-sm transition-colors group-hover:text-foreground">
              {log.nodeName || log.nodeType}
            </span>
            <span className="text-muted-foreground text-xs">
              {getStatusLabel(log.status)}
            </span>
            {log.duration ? (
              <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
                {formatDuration(log.duration)}
              </span>
            ) : null}
          </div>
        </button>

        {isExpanded ? (
          <div className="mt-2 space-y-3">
            {log.input !== null && log.input !== undefined ? (
              <CollapsibleSection copyData={log.input} title="Input">
                <pre className="overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
                  <JsonWithLinks data={log.input} />
                </pre>
              </CollapsibleSection>
            ) : null}
            {log.output !== null && log.output !== undefined ? (
              <OutputDisplay
                actionType={log.nodeType}
                input={log.input}
                output={log.output}
              />
            ) : null}
            {log.error ? (
              <CollapsibleSection
                copyData={log.error}
                defaultExpanded
                isError
                title="Error"
              >
                <pre className="overflow-auto rounded-lg border border-red-500/20 bg-red-500/5 p-3 font-mono text-red-600 text-xs leading-relaxed">
                  {log.error}
                </pre>
              </CollapsibleSection>
            ) : null}
            {log.input || log.output || log.error ? null : (
              <div className="rounded-lg border bg-muted/30 py-4 text-center text-muted-foreground text-xs">
                No data recorded
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function WorkflowRunTimeline({ logs }: { logs: ExecutionLog[] }) {
  if (logs.length === 0) {
    return (
      <div className="py-8 text-center text-muted-foreground text-xs">
        No steps recorded
      </div>
    );
  }

  return (
    <div className="pl-1">
      {logs.map((log, index) => (
        <TimelineEntry
          isLast={index === logs.length - 1}
          key={log.id}
          log={log}
        />
      ))}
    </div>
  );
}
