import { useAtomValue } from "jotai";
import { Fragment, type RefObject, useState } from "react";
import { getRelativeTime } from "@wfgraph/shared/utils/time";
import { useNowMs } from "#src/hooks/effects";
import { cn } from "@wfgraph/shared/utils";
import {
  type ExecutorSchedule,
  executorActivityCopy,
  executorDetails,
  type NodeNamer,
  serverNowMs,
} from "#src/lib/run-executor-activity";
import { parseConditionModel } from "@wfgraph/shared/conditions/conditions";
import { readLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { Button } from "#src/components/ui/button";
import {
  type ExecutionEvent,
  type ExecutionExit,
  type ExecutionLog,
  type ExecutionWait,
  isRunInProgress,
  type WorkflowExecution,
} from "#src/lib/execution-logs";
import { orderedRunLogs } from "#src/lib/run-node-evidence";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { findEntity } from "@wfgraph/shared/extensions/catalog";
import { getEntityConditionFields } from "#src/lib/upstream-node-fields";
import { ConditionSummary } from "./config/condition-summary";
import { CollapsibleSection } from "./workflow-run-shared";
import {
  getRunOutcome,
  retryingLog,
  WorkflowRunSummaryRow,
} from "./workflow-run-summary-row";
import { compact } from "es-toolkit/array";
import { WorkflowRunNodeIndex } from "./workflow-run-timeline";

export type WorkflowRunDetailProps = {
  execution: WorkflowExecution;
  runNumber: number;
  /** Why this run is no longer in the list behind it, when it has left. */
  notice?: string | undefined;
  logs: ExecutionLog[];
  events: ExecutionEvent[];
  exit: ExecutionExit | null;
  waits: ExecutionWait[];
  /**
   * Where the database executor holds the run, with the browser's clock when
   * that answer arrived. Null once the run has ended and before its logs load.
   */
  executor: RunExecutorHold | null;
  isCanceling: boolean;
  isResuming: boolean;
  onCancel?: ((executionId: string) => void) | undefined;
  onResume?: ((token: string) => void) | undefined;
  /** A journey entry was chosen, which shows that execution's evidence. */
  onSelectLog: (log: ExecutionLog) => void;
  /** The journey entry, by log id, to focus once it renders. */
  focusLogId?: string | null | undefined;
  onFocusRestored?: (() => void) | undefined;
  /** Whether the run summary's heading takes focus when the detail mounts. */
  focusSummaryOnMount?: boolean | undefined;
  /**
   * The run overview's scroll container binding, for a frame that keeps the
   * overview's scroll position.
   */
  scroll?:
    | {
        ref: RefObject<HTMLDivElement | null>;
        onScroll: () => void;
        onScrollEnd: () => void;
      }
    | undefined;
};

/** An open run's executor schedule, and when the browser received it. */
export type RunExecutorHold = {
  schedule: ExecutorSchedule;
  receivedAtMs: number;
};

/**
 * What the database executor is doing about an in-progress run: one headline,
 * an optional second line, and the schedule's facts behind a disclosure. Shows
 * nothing for a run asleep on its parks, which the waits section explains. A
 * one-second clock keeps the elapsed times and the warning threshold current
 * between polls.
 */
function RunExecutorSection({
  hold,
  nameOf,
}: {
  hold: RunExecutorHold;
  nameOf: NodeNamer;
}) {
  const browserNowMs = useNowMs({ intervalMs: 1000, enabled: true });
  const { schedule } = hold;
  const nowMs = serverNowMs({
    observedAt: schedule.observedAt,
    receivedAtMs: hold.receivedAtMs,
    nowMs: browserNowMs,
  });
  const copy =
    schedule.activity === null
      ? null
      : executorActivityCopy({
          activity: schedule.activity,
          nameOf,
          nowMs,
          overdueAfterMs: schedule.overdueAfterMs,
        });
  if (copy === null) {
    return null;
  }
  const warns = copy.tone === "warning";

  return (
    <section
      aria-label="Executor"
      className={cn(
        "space-y-1.5 rounded-md border p-3",
        warns && "border-warning/40"
      )}
    >
      <p
        className={cn(
          "break-words font-medium text-sm leading-5",
          warns && "text-warning"
        )}
      >
        {copy.headline}
      </p>
      {copy.detail === null ? null : (
        <p className="break-words text-muted-foreground text-xs leading-5">
          {copy.detail}
        </p>
      )}
      <CollapsibleSection title="Executor details">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
          {executorDetails({ schedule, nowMs }).map((fact) => (
            <Fragment key={fact.term}>
              <dt className="text-muted-foreground text-xs leading-5">
                {fact.term}
              </dt>
              <dd
                className={cn(
                  "break-words text-sm leading-5",
                  fact.mono && "font-mono text-xs"
                )}
              >
                {fact.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      </CollapsibleSection>
    </section>
  );
}

function exitSummary(input: {
  exit: ExecutionExit;
  entityLabel: string;
  nodeLabel: string;
}): string {
  return input.exit.reason === "entity_not_found"
    ? `Exited before “${input.nodeLabel}” because the ${input.entityLabel} no longer exists.`
    : `Exited before “${input.nodeLabel}” because the ${input.entityLabel} was no longer eligible.`;
}

/** One sentence naming what a parked wait is waiting for. */
export function waitingSummary(wait: ExecutionWait): string {
  if (wait.subscribedEvents.length > 0) {
    return `Waiting for ${wait.subscribedEvents.join(", ")}`;
  }
  if (wait.waitUntil) {
    return `Waiting until ${wait.waitUntil.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    })}`;
  }
  return "Waiting on a timer";
}

/**
 * The overview of one run: its summary, active waits, exit details, failure
 * summary, node journey, and activity. A node's own evidence is shown by the
 * frame around it, which `onSelectLog` asks for.
 */
export function WorkflowRunDetail({
  execution,
  runNumber,
  notice,
  logs,
  events,
  exit,
  waits,
  executor,
  isCanceling,
  isResuming,
  onCancel,
  onResume,
  onSelectLog,
  focusLogId,
  onFocusRestored,
  focusSummaryOnMount = false,
  scroll,
}: WorkflowRunDetailProps) {
  const executionGraph = useAtomValue(executionOverlayGraphAtom);
  const catalog = useExtensionCatalog();
  // Whether the summary takes focus is decided once, when the overview mounts.
  const [focusesSummary] = useState(focusSummaryOnMount);
  // The list row is what cancel paints first. Logs and waits can still be the
  // last in-flight snapshot until their query refetches, so the journey follows
  // the run status the header already shows.
  const sortedLogs = orderedRunLogs(logs, execution.status);
  const activeWaits = isRunInProgress(execution.status) ? waits : [];

  const failedLog = sortedLogs.findLast((log) => log.status === "error");
  const exitNodeLabel = exit
    ? (executionGraph?.nodes.find((node) => node.id === exit.nodeId)?.data
        .label ??
      sortedLogs.find((log) => log.nodeId === exit.nodeId)?.nodeName ??
      exit.nodeId)
    : undefined;
  const exitEntityLabel = exit
    ? (findEntity(catalog, exit.entityType)?.label ?? exit.entityType)
    : undefined;
  const serializedExitCondition = exit
    ? (executionGraph?.nodes ?? [])
        .filter((node) => node.data.type === "lifecycle")
        .map((node) => readLifecycleRules(node.data.config))
        .find((rules) => rules?.trackedEntity?.type === exit.entityType)
        ?.entityEligibility?.condition
    : undefined;
  const parsedExitCondition = serializedExitCondition
    ? parseConditionModel(serializedExitCondition)
    : undefined;
  const exitCondition = parsedExitCondition?.valid
    ? parsedExitCondition.model
    : undefined;
  const exitConditionFields = exit
    ? getEntityConditionFields(catalog, exit.entityType)
    : [];
  // The executor names a node from its log row; a node with none yet is named
  // from the pinned graph, and by its id when that has not loaded.
  const nameOf: NodeNamer = ({ nodeId, nodeName }) =>
    nodeId === null
      ? null
      : (nodeName ??
        executionGraph?.nodes.find((node) => node.id === nodeId)?.data.label ??
        nodeId);
  // The nodes with a step the executor will run again, which the header and
  // the journey call retrying, as the canvas does.
  const retryingNodeIds = isRunInProgress(execution.status)
    ? compact(executor?.schedule.failingSteps.map((step) => step.nodeId) ?? [])
    : [];
  const primaryWait = activeWaits[0];
  const outcome =
    execution.status === "waiting" &&
    primaryWait &&
    retryingLog(sortedLogs, retryingNodeIds) === undefined
      ? `Waiting at ${primaryWait.nodeName}`
      : getRunOutcome(execution, sortedLogs, retryingNodeIds);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkflowRunSummaryRow
        execution={execution}
        focusOnMount={focusesSummary}
        isCanceling={isCanceling}
        onCancel={isRunInProgress(execution.status) ? onCancel : undefined}
        outcome={outcome}
        runNumber={runNumber}
        variant="header"
      />

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 [scrollbar-gutter:stable_both-edges]"
        onScroll={scroll?.onScroll}
        onScrollEnd={scroll?.onScrollEnd}
        ref={scroll?.ref}
      >
        <div className="space-y-4">
          {executor !== null && isRunInProgress(execution.status) ? (
            <RunExecutorSection hold={executor} nameOf={nameOf} />
          ) : null}

          {notice ? (
            <p className="rounded-md border bg-muted/30 p-2 text-muted-foreground text-xs">
              {notice}
            </p>
          ) : null}

          {activeWaits.length > 0 ? (
            <section className="space-y-3 rounded-md border border-warning/30 bg-warning/10 p-3">
              {activeWaits.map((wait) => (
                <div className="space-y-1.5" key={wait.id}>
                  <h3 className="font-medium text-warning text-xs">
                    Waiting at {wait.nodeName}
                  </h3>
                  <p className="break-words text-xs">{waitingSummary(wait)}</p>
                  {wait.resumeToken && onResume ? (
                    <Button
                      disabled={isResuming}
                      onClick={() => onResume(wait.resumeToken ?? "")}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Resume now
                    </Button>
                  ) : null}
                </div>
              ))}
            </section>
          ) : null}

          {execution.status === "exited" ? (
            <section className="space-y-1.5 rounded-md border border-cancelled/30 p-3">
              <h3 className="font-semibold text-cancelled text-sm">
                Exit details
              </h3>
              <p className="break-words text-sm leading-5">
                {exit && exitNodeLabel && exitEntityLabel
                  ? exitSummary({
                      exit,
                      nodeLabel: exitNodeLabel,
                      entityLabel: exitEntityLabel,
                    })
                  : "This run exited because Entity eligibility did not pass."}
              </p>
              {exit ? (
                <>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
                    <dt className="text-muted-foreground text-xs leading-5">
                      Entity
                    </dt>
                    <dd className="text-sm leading-5">{exitEntityLabel}</dd>
                    <dt className="text-muted-foreground text-xs leading-5">
                      Result
                    </dt>
                    <dd className="text-sm leading-5">
                      {exit.reason === "entity_not_found"
                        ? "Entity not found"
                        : "Eligibility rule did not match"}
                    </dd>
                    <dt className="text-muted-foreground text-xs leading-5">
                      Checked
                    </dt>
                    <dd className="text-sm leading-5">
                      {exit.checkedAt.toLocaleString(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </dd>
                  </dl>
                  {exitCondition ? (
                    <div className="space-y-1.5 border-t pt-2">
                      <p className="font-medium text-sm">Eligible when</p>
                      <ConditionSummary
                        compact
                        fields={exitConditionFields}
                        model={exitCondition}
                        setOperatorsRequireEnumValues
                      />
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      The eligibility rule is unavailable for this workflow
                      version.
                    </p>
                  )}
                </>
              ) : null}
            </section>
          ) : null}

          {execution.status === "failed" && (failedLog || execution.error) ? (
            <section className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
              <h3 className="font-medium text-destructive text-xs">
                {failedLog
                  ? `Failed at ${failedLog.nodeName || failedLog.nodeType}`
                  : "Run failed"}
              </h3>
              <p className="mt-1 break-words text-destructive text-xs">
                {failedLog?.error ?? execution.error}
              </p>
            </section>
          ) : null}

          <WorkflowRunNodeIndex
            exit={
              exit && exitNodeLabel ? { nodeLabel: exitNodeLabel } : undefined
            }
            focusLogId={focusLogId}
            logs={sortedLogs}
            onFocusRestored={onFocusRestored}
            retryingNodeIds={retryingNodeIds}
            onSelect={onSelectLog}
          />

          {events.length > 0 ? (
            <CollapsibleSection title={`Activity · ${events.length}`}>
              <div className="space-y-2">
                {events.map((event) => (
                  <div
                    className="flex items-center justify-between gap-2"
                    key={event.id}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-xs">
                        {event.message}
                      </div>
                      <div className="truncate text-muted-foreground text-xs">
                        {event.eventType}
                      </div>
                    </div>
                    <div className="shrink-0 text-muted-foreground text-xs">
                      {getRelativeTime(event.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          ) : null}
        </div>
      </div>
    </div>
  );
}
