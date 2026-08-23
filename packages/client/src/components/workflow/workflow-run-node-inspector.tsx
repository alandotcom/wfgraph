import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import { useRef, useState } from "react";
import { Button } from "#src/components/ui/button";
import { useAfterCommit } from "#src/hooks/effects";
import {
  displayNodesAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { ExecutionLog } from "#src/lib/execution-logs";
import { cn } from "@wfgraph/shared/utils";
import {
  CopyButton,
  formatDuration,
  getStatusTextClass,
  JSON_PRE_CLASS,
  JsonWithLinks,
  nodeKindLabel,
  OutputDisplay,
} from "./workflow-run-shared";

function hasRecordedValue(value: unknown): boolean {
  return value !== null && value !== undefined;
}

type PayloadTab = {
  id: "input" | "output";
  label: "Input" | "Output";
  value: unknown;
};

function TechnicalDetails({ log }: { log: ExecutionLog }) {
  const payloads: PayloadTab[] = [];
  if (hasRecordedValue(log.input)) {
    payloads.push({ id: "input", label: "Input", value: log.input });
  }
  if (hasRecordedValue(log.output)) {
    payloads.push({ id: "output", label: "Output", value: log.output });
  }

  const [open, setOpen] = useState(false);
  const [requestedTab, setRequestedTab] = useState<PayloadTab["id"]>(
    payloads.some((payload) => payload.id === "output") ? "output" : "input"
  );
  const tabRefs = useRef(new Map<PayloadTab["id"], HTMLButtonElement>());
  const activeTab =
    payloads.find((payload) => payload.id === requestedTab) ?? payloads[0];

  if (!activeTab) {
    return null;
  }

  const moveTabFocus = (direction: -1 | 1) => {
    const currentIndex = payloads.findIndex(
      (payload) => payload.id === activeTab.id
    );
    const nextIndex =
      (currentIndex + direction + payloads.length) % payloads.length;
    const next = payloads[nextIndex];
    if (next) {
      setRequestedTab(next.id);
      tabRefs.current.get(next.id)?.focus();
    }
  };

  return (
    <section
      className={cn(
        "shrink-0 border-t bg-background transition-[height] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-opacity motion-reduce:duration-100",
        open ? "h-[min(35vh,18rem)] md:h-[38%]" : "h-11 md:h-9"
      )}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div
          className={cn(
            "flex h-11 shrink-0 items-center md:h-9",
            open ? "border-b px-2" : ""
          )}
        >
          <button
            aria-controls="technical-details-panel"
            aria-expanded={open}
            className={cn(
              "flex h-full items-center gap-1.5 font-medium text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
              open
                ? "px-1"
                : "w-full px-3 text-left transition-colors duration-100 hover:bg-muted/60 focus-visible:ring-inset focus-visible:ring-ring/30"
            )}
            onClick={() => setOpen((current) => !current)}
            type="button"
          >
            {open ? (
              <ChevronDown className="size-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3 text-muted-foreground" />
            )}
            Technical details
          </button>
          {open ? (
            <>
              <div
                aria-label="Technical payload"
                className="ml-auto flex h-full items-end gap-1"
                role="tablist"
              >
                {payloads.map((payload) => (
                  <button
                    aria-controls="technical-details-panel"
                    aria-selected={activeTab.id === payload.id}
                    className={cn(
                      "h-11 border-b-2 border-transparent px-2 text-muted-foreground text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 md:h-8",
                      activeTab.id === payload.id &&
                        "border-foreground text-foreground"
                    )}
                    id={`technical-tab-${payload.id}`}
                    key={payload.id}
                    onClick={() => setRequestedTab(payload.id)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowLeft") {
                        event.preventDefault();
                        moveTabFocus(-1);
                      } else if (event.key === "ArrowRight") {
                        event.preventDefault();
                        moveTabFocus(1);
                      }
                    }}
                    ref={(element) => {
                      if (element) {
                        tabRefs.current.set(payload.id, element);
                      } else {
                        tabRefs.current.delete(payload.id);
                      }
                    }}
                    role="tab"
                    tabIndex={activeTab.id === payload.id ? 0 : -1}
                    type="button"
                  >
                    {payload.label}
                  </button>
                ))}
              </div>
              <CopyButton data={activeTab.value} />
            </>
          ) : null}
        </div>
        {open ? (
          <div
            aria-labelledby={`technical-tab-${activeTab.id}`}
            className="min-h-0 flex-1 overflow-auto bg-muted/30"
            id="technical-details-panel"
            role="tabpanel"
          >
            <pre className={JSON_PRE_CLASS}>
              <JsonWithLinks data={activeTab.value} />
            </pre>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function WorkflowRunNodeInspector({
  logs,
  selectedLogId,
  onBack,
}: {
  logs: ExecutionLog[];
  selectedLogId?: string | null;
  onBack?: () => void;
}) {
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const displayNodes = useAtomValue(displayNodesAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useAfterCommit(`${selectedNodeId}:${selectedLogId ?? ""}`, () =>
    headingRef.current?.focus()
  );

  if (!selectedNodeId) {
    return null;
  }

  const canvasNode = displayNodes.find((node) => node.id === selectedNodeId);
  const selectedLog = selectedLogId
    ? logs.find(
        (entry) => entry.id === selectedLogId && entry.nodeId === selectedNodeId
      )
    : undefined;
  const log =
    selectedLog ?? logs.findLast((entry) => entry.nodeId === selectedNodeId);
  const title =
    canvasNode?.data.label?.trim() || log?.nodeName || log?.nodeType || "Node";
  const kind = nodeKindLabel(
    log?.nodeType ?? canvasNode?.data.type ?? "action"
  );
  const statusLabel = log ? (
    <span className={getStatusTextClass(log.status)}>
      {log.status === "success"
        ? "Success"
        : log.status === "error"
          ? "Error"
          : log.status === "running"
            ? "Running"
            : log.status === "cancelled"
              ? "Cancelled"
              : "Pending"}
    </span>
  ) : (
    <span className="text-muted-foreground">Not reached</span>
  );

  const handleBack = () => {
    setSelectedNode(null);
    onBack?.();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b bg-background px-3 py-3">
        <div className="flex min-w-0 items-center gap-1">
          <Button
            aria-label="Back to run overview"
            className="-ml-1 max-md:size-11"
            onClick={handleBack}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ArrowLeft />
          </Button>
          <h2
            className="min-w-0 break-words font-semibold text-sm outline-none"
            ref={headingRef}
            tabIndex={-1}
          >
            {title}
          </h2>
        </div>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 pl-6 text-muted-foreground text-xs">
          <span>{kind}</span>
          <span aria-hidden="true">·</span>
          {statusLabel}
          {log?.duration ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {formatDuration(log.duration)}
              </span>
            </>
          ) : null}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 [scrollbar-gutter:stable_both-edges]">
        {!log ? (
          <p className="text-muted-foreground text-sm">
            This node was not reached
          </p>
        ) : (
          <div className="space-y-5">
            {log.error ? (
              <section className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
                <h3 className="font-medium text-destructive text-xs">
                  Step failed
                </h3>
                <p className="mt-1 break-words text-destructive text-xs">
                  {log.error}
                </p>
              </section>
            ) : log.status === "running" || log.status === "pending" ? (
              <p className="rounded-md border border-info/30 bg-info/10 p-3 text-info text-xs">
                {log.status === "running"
                  ? "This step is still running."
                  : "This step is waiting to start."}
              </p>
            ) : null}

            <section>
              <h3 className="mb-2 font-medium text-xs">Result</h3>
              {hasRecordedValue(log.output) ? (
                <OutputDisplay
                  actionType={log.nodeType}
                  input={log.input}
                  output={log.output}
                />
              ) : (
                <p className="text-muted-foreground text-xs">
                  No result was recorded.
                </p>
              )}
            </section>
          </div>
        )}
      </div>

      {log ? <TechnicalDetails log={log} /> : null}
    </div>
  );
}
