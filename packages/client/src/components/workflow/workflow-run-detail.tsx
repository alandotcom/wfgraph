import { Hourglass, XCircle } from "lucide-react";
import { useAtomValue } from "jotai";
import { Fragment, type RefObject, useState } from "react";
import { formatExactTime } from "@wfgraph/shared/utils/time";
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
import { runActivitySentence } from "#src/lib/run-activity";
import { orderedRunLogs } from "#src/lib/run-node-evidence";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  type ExtensionCatalog,
  findEntity,
} from "@wfgraph/shared/extensions/catalog";
import { eventLabel } from "./config/lifecycle-policy-summary";
import { getEntityConditionFields } from "#src/lib/upstream-node-fields";
import { ConditionSummary } from "./config/condition-summary";
import {
  CollapsibleSection,
  RUN_FIELD_COLUMNS,
  RUN_FIELD_LABEL,
  RUN_FIELD_VALUE,
} from "./workflow-run-shared";
import {
  getRunOutcome,
  retryingLog,
  WorkflowRunSummaryRow,
} from "./workflow-run-summary-row";
import { compact } from "es-toolkit/array";
import { FailedRunAftermath, RunFailureText } from "./workflow-run-failure";

export type WorkflowRunDetailProps = {
  execution: WorkflowExecution;
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
  /** Whether a Continue now for this run is in flight. */
  isContinuing: boolean;
  onCancel?: ((executionId: string) => void) | undefined;
  onResume?: ((token: string) => void) | undefined;
  /**
   * Ends one timed Wait of the run now, by its wait row id. Present only for
   * a run of the draft, which is the one run Continue now is offered on.
   */
  onContinueWait?: ((waitStateId: string) => void) | undefined;
  /** The failed step was chosen, which shows that execution's evidence. */
  onSelectLog: (log: ExecutionLog) => void;
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
        <dl className={cn("grid gap-y-1", RUN_FIELD_COLUMNS)}>
          {executorDetails({ schedule, nowMs }).map((fact) => (
            <Fragment key={fact.term}>
              <dt className={RUN_FIELD_LABEL}>{fact.term}</dt>
              <dd className={cn(RUN_FIELD_VALUE, fact.mono && "font-mono")}>
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

/**
 * One sentence naming what a parked wait is waiting for, with each Event named
 * by its label in `catalog`, as the canvas names an Event Split's outlets.
 */
export function waitingSummary(
  wait: ExecutionWait,
  catalog: ExtensionCatalog
): string {
  if (wait.subscribedEvents.length > 0) {
    return `Waiting for ${wait.subscribedEvents
      .map((name) => eventLabel(catalog, name))
      .join(", ")}`;
  }
  if (wait.waitUntil) {
    return `Waiting until ${formatExactTime(wait.waitUntil)}`;
  }
  return "Waiting on a timer";
}

/**
 * The overview of one run: its summary, active waits, exit details, failure
 * summary, and activity. The run's steps are its outline in the left column.
 * A node's own evidence is shown by the frame around it, which `onSelectLog`
 * asks for.
 */
export function WorkflowRunDetail({
  execution,
  notice,
  logs,
  events,
  exit,
  waits,
  executor,
  isCanceling,
  isResuming,
  isContinuing,
  onCancel,
  onResume,
  onContinueWait,
  onSelectLog,
  focusSummaryOnMount = false,
  scroll,
}: WorkflowRunDetailProps) {
  const executionGraph = useAtomValue(executionOverlayGraphAtom);
  const catalog = useExtensionCatalog();
  // Whether the summary takes focus is decided once, when the overview mounts.
  const [focusesSummary] = useState(focusSummaryOnMount);
  // The list row is what cancel paints first. Logs and waits can still be the
  // last in-flight snapshot until their query refetches, so the failed step
  // follows the run status the header already shows.
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
  // The nodes with a step the executor will run again, which the header calls
  // retrying, as the canvas does.
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
    <div className="flex h-full min-h-0 flex-col" data-slot="run-overview">
      <WorkflowRunSummaryRow
        execution={execution}
        focusOnMount={focusesSummary}
        isCanceling={isCanceling}
        onCancel={isRunInProgress(execution.status) ? onCancel : undefined}
        outcome={outcome}
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
                  <h3 className="flex items-center gap-1.5 font-medium text-xs">
                    <Hourglass
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-warning"
                    />
                    Waiting at {wait.nodeName}
                  </h3>
                  <p className="break-words text-xs">
                    {waitingSummary(wait, catalog)}
                  </p>
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
                  {wait.waitType === "delay" && onContinueWait ? (
                    <Button
                      disabled={isContinuing}
                      onClick={() => onContinueWait(wait.id)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Continue now
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
                  <dl className={cn("grid gap-y-1", RUN_FIELD_COLUMNS)}>
                    <dt className={RUN_FIELD_LABEL}>Entity</dt>
                    <dd className={RUN_FIELD_VALUE}>{exitEntityLabel}</dd>
                    <dt className={RUN_FIELD_LABEL}>Result</dt>
                    <dd className={RUN_FIELD_VALUE}>
                      {exit.reason === "entity_not_found"
                        ? "Entity not found"
                        : "Eligibility rule did not match"}
                    </dd>
                    <dt className={RUN_FIELD_LABEL}>Checked</dt>
                    <dd className={RUN_FIELD_VALUE}>
                      {formatExactTime(exit.checkedAt)}
                    </dd>
                  </dl>
                  {exitCondition ? (
                    <div className="space-y-1.5 border-t pt-2">
                      <p className="font-medium text-sm">Eligible when</p>
                      <ConditionSummary
                        compact
                        fields={exitConditionFields}
                        model={exitCondition}
                        nodes={executionGraph?.nodes ?? []}
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
            // The band's tint, border and icon carry the signal. Its text is
            // foreground, because red text on a red tint measures under 4.5:1.
            <section className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
              <h3 className="flex items-center gap-1.5 font-medium text-xs">
                <XCircle
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-destructive"
                />
                {failedLog ? (
                  // The step the run stopped at, as a way into its evidence.
                  <button
                    className="rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onSelectLog(failedLog)}
                    type="button"
                  >
                    Failed at {failedLog.nodeName || failedLog.nodeType}
                  </button>
                ) : (
                  "Run failed"
                )}
              </h3>
              <div className="mt-1">
                <RunFailureText
                  className="text-xs"
                  detailClassName="text-foreground"
                  error={failedLog?.error ?? execution.error ?? ""}
                  nodeId={failedLog?.nodeId ?? null}
                  startEventName={execution.startEventName}
                />
              </div>
              {execution.status === "failed" && failedLog ? (
                <FailedRunAftermath
                  className="mt-2 text-xs"
                  failedNodeId={failedLog.nodeId}
                  ranNodeIds={new Set(sortedLogs.map((log) => log.nodeId))}
                />
              ) : null}
            </section>
          ) : null}

          {events.length > 0 ? (
            <CollapsibleSection title={`Activity · ${events.length}`}>
              {/* Each entry is a sentence in the Runs view's words, its clock
                  time, and its stored type as secondary text for a developer. */}
              <div className="space-y-2">
                {events.map((event) => (
                  <div
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2"
                    key={event.id}
                  >
                    <div className="break-words font-medium text-xs">
                      {runActivitySentence({
                        event,
                        run: execution,
                        eventLabel: (name) => eventLabel(catalog, name),
                        nodeName: (nodeId) =>
                          nameOf({ nodeId, nodeName: null }),
                      })}
                    </div>
                    <div className="shrink-0 text-muted-foreground text-xs">
                      {formatExactTime(event.createdAt)}
                    </div>
                    <div className="truncate font-mono text-muted-foreground text-xs">
                      {event.eventType}
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
