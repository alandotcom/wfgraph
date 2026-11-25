import { useRef, useState } from "react";
import { cn } from "@wfgraph/shared/utils";
import { useAfterCommit } from "#src/hooks/effects";
import { type ExecutionLog } from "#src/lib/execution-logs";
import {
  listDuration,
  listStatusTextClass,
  nodeStatusLabel,
  nodeStatusTone,
  runNodeEvidenceLabel,
  statusToneDotClass,
} from "./workflow-run-shared";

/** No node ids, as one stable array. */
const NO_NODES: readonly string[] = [];

/** The fewest consecutive successful entries a fold stands in for. */
const MIN_FOLDED_ENTRIES = 3;

/**
 * The journey as rendered: each entry on its own, or a run of consecutive
 * successful entries folded into one row.
 */
type JourneyItem =
  | { kind: "entry"; log: ExecutionLog }
  | { kind: "fold"; logs: ExecutionLog[] };

/**
 * `logs` with every run of `MIN_FOLDED_ENTRIES` or more consecutive successful
 * entries folded into one item.
 */
function foldSuccessfulRuns(logs: readonly ExecutionLog[]): JourneyItem[] {
  // Consecutive entries, split wherever an entry's success differs from the
  // one before it.
  const stretches = logs.reduce<ExecutionLog[][]>((result, log) => {
    const last = result.at(-1);
    const continues =
      last !== undefined &&
      (last[0]?.status === "success") === (log.status === "success");
    return continues
      ? [...result.slice(0, -1), [...last, log]]
      : [...result, [log]];
  }, []);
  return stretches.flatMap((stretch): JourneyItem[] =>
    stretch[0]?.status === "success" && stretch.length >= MIN_FOLDED_ENTRIES
      ? [{ kind: "fold", logs: stretch }]
      : stretch.map((log) => ({ kind: "entry", log }))
  );
}

/**
 * A run's node journey: one entry per recorded node execution, in start order,
 * and the Entity eligibility exit when the run exited. A node among
 * `retryingNodeIds` reads "Retrying" in the warning token, whatever its log's
 * status, and an unfinished entry of a node among `waitingNodeIds` reads
 * "Waiting". Choosing an entry calls
 * `onSelect`. `focusLogId` names an entry to focus once it renders; focusing
 * keeps the scroll the journey already has, and `onFocusRestored` follows.
 *
 * With `foldSuccessful`, each run of consecutive successful entries shows as
 * one row until the reader expands it, so the entry where a failed run stopped
 * sits near the top. A focus request for a folded entry expands the journey.
 * A status word reads in its signal color only where the entry needs
 * attention; a successful entry's word is muted and its dot keeps the color.
 */
export function WorkflowRunNodeIndex({
  logs,
  exit,
  focusLogId,
  onFocusRestored,
  onSelect,
  retryingNodeIds = NO_NODES,
  waitingNodeIds = NO_NODES,
  foldSuccessful = false,
}: {
  logs: ExecutionLog[];
  exit?: { nodeLabel: string } | undefined;
  focusLogId?: string | null | undefined;
  onFocusRestored?: (() => void) | undefined;
  onSelect: (log: ExecutionLog) => void;
  /** The nodes with a step the executor will run again, read as "Retrying". */
  retryingNodeIds?: readonly string[] | undefined;
  /** The nodes the run is parked on, whose open entries read as "Waiting". */
  waitingNodeIds?: readonly string[] | undefined;
  /** Whether runs of consecutive successful entries start folded. */
  foldSuccessful?: boolean | undefined;
}) {
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const [expanded, setExpanded] = useState(false);
  const folded = foldSuccessful ? foldSuccessfulRuns(logs) : null;
  // A focus request for an entry inside a fold shows every entry, and keeps
  // them shown once the request is answered, so the focused row stays mounted.
  const focusInFold =
    focusLogId != null &&
    folded !== null &&
    folded.some(
      (item) =>
        item.kind === "fold" && item.logs.some((log) => log.id === focusLogId)
    );
  const items: JourneyItem[] =
    folded === null || expanded || focusInFold
      ? logs.map((log) => ({ kind: "entry", log }))
      : folded;

  useAfterCommit(focusLogId, () => {
    if (!focusLogId) {
      return;
    }
    if (focusInFold) {
      setExpanded(true);
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
        {items.map((item, index) => {
          const hasNext = index < items.length - 1 || exit !== undefined;
          if (item.kind === "fold") {
            return (
              <li className="relative pl-5" key={item.logs[0]?.id}>
                {hasNext ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-4 bottom-[-1rem] left-[0.4375rem] w-px bg-border"
                  />
                ) : null}
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-[1.125rem] left-1 size-2 rounded-full ring-2 ring-background",
                    statusToneDotClass("success")
                  )}
                />
                <button
                  className="flex min-h-11 w-full items-center rounded-sm px-2 py-1.5 text-left text-muted-foreground text-sm transition-colors duration-100 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                  onClick={() => setExpanded(true)}
                  type="button"
                >
                  Show {item.logs.length} successful steps
                </button>
              </li>
            );
          }
          const { log } = item;
          const duration = listDuration(log.duration);
          const unfinished =
            log.status === "running" || log.status === "pending";
          const waiting = unfinished && waitingNodeIds.includes(log.nodeId);
          const retrying = retryingNodeIds.includes(log.nodeId);
          const status = retrying
            ? runNodeEvidenceLabel("retrying")
            : waiting
              ? runNodeEvidenceLabel("waiting")
              : {
                  text: nodeStatusLabel(log.status),
                  tone: nodeStatusTone(log.status),
                };
          return (
            <li className="relative pl-5" key={log.id}>
              {hasNext ? (
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
                    !waiting &&
                    "ring-info/20 motion-safe:animate-pulse",
                  statusToneDotClass(status.tone)
                )}
              />
              <button
                aria-label={`${log.nodeName || log.nodeType}, ${status.text}`}
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
                  ) : log.status === "running" && !waiting ? (
                    <span className="block text-info text-xs">In progress</span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-baseline gap-2">
                  <span
                    className={cn("text-xs", listStatusTextClass(status.tone))}
                  >
                    {status.text}
                  </span>
                  {duration === null ? null : (
                    <span className="font-mono text-muted-foreground text-xs tabular-nums">
                      {duration}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
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
