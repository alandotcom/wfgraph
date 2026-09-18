import { compact } from "es-toolkit/array";
import { isNotNil } from "es-toolkit/predicate";
import { cn } from "@wfgraph/shared/utils";
import { Button } from "#src/components/ui/button";
import type { ExecutionLog } from "#src/lib/execution-logs";
import type { RunNodeEvidence } from "#src/lib/run-node-evidence";
import { Section } from "./canvas-reveal/reveal-sections";
import { RUN_POLL_MS } from "./use-workflow-runs";
import { waitingSummary } from "./workflow-run-detail";
import {
  CopyButton,
  formatDuration,
  JSON_PRE_CLASS,
  nodeStatusLabel,
  nodeStatusTone,
  statusToneTextClass,
  JsonWithLinks,
  OutputDisplay,
} from "./workflow-run-shared";

function formatTime(date: Date): string {
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

/** A notice at the top of the evidence about what it can and cannot show. */
function Notice({ children }: { children: string }) {
  return (
    <p
      className="rounded-md border bg-muted/30 p-2 text-muted-foreground text-xs"
      data-slot="run-evidence-notice"
    >
      {children}
    </p>
  );
}

/** A recorded JSON payload with its Copy button, or a line saying none was. */
function Payload({
  title,
  value,
  emptyText,
}: {
  title: string;
  value: unknown;
  emptyText: string;
}) {
  return (
    <Section
      action={isNotNil(value) ? <CopyButton data={value} /> : undefined}
      title={title}
    >
      {isNotNil(value) ? (
        <div className="overflow-auto rounded-md border bg-muted/30">
          <pre className={JSON_PRE_CLASS}>
            <JsonWithLinks data={value} />
          </pre>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{emptyText}</p>
      )}
    </Section>
  );
}

function ExecutionList({
  executions,
  shown,
  onChoose,
}: {
  executions: readonly ExecutionLog[];
  shown: ExecutionLog;
  onChoose: (logId: string) => void;
}) {
  return (
    <ul aria-label="Executions" className="space-y-1">
      {executions.map((execution, index) => (
        <li key={execution.id}>
          <button
            aria-pressed={execution.id === shown.id}
            className={cn(
              "grid min-h-9 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2 py-1 text-left transition-colors duration-100 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
              execution.id === shown.id && "border-foreground bg-muted/50"
            )}
            onClick={() => onChoose(execution.id)}
            type="button"
          >
            <span className="font-medium text-sm">Execution {index + 1}</span>
            <span className="flex items-baseline gap-2 text-xs">
              <span
                className={statusToneTextClass(
                  nodeStatusTone(execution.status)
                )}
              >
                {nodeStatusLabel(execution.status)}
              </span>
              {execution.duration ? (
                <span className="font-mono text-muted-foreground tabular-nums">
                  {formatDuration(execution.duration)}
                </span>
              ) : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The recorded evidence of one node in one run: its executions, timing, error or
 * cancellation, the wait it holds with Resume, its activity, result, input,
 * output, and configuration. An execution is one time the run reached the node,
 * and retries inside it show as its final outcome. Notices say when the node is
 * gone from the pinned graph, when that graph is loading or unavailable, and
 * when the run is still polling. Choosing an execution calls
 * `onChooseExecution` and nothing else.
 */
export function WorkflowRunNodeEvidence({
  evidence,
  isResuming,
  onChooseExecution,
  onResume,
}: {
  evidence: RunNodeEvidence;
  isResuming: boolean;
  onChooseExecution: (logId: string) => void;
  onResume?: ((token: string) => void) | undefined;
}) {
  const { shownExecution: shown, executions } = evidence;
  const executionNumber = shown ? executions.indexOf(shown) + 1 : 0;
  const unfinished =
    shown !== null &&
    (shown.status === "running" || shown.status === "pending");
  const notices = compact([
    evidence.removed ? "This step is not in the graph this run uses." : null,
    evidence.pinnedGraph === "unavailable"
      ? "The graph this run used could not be loaded, so its configuration is unavailable."
      : null,
    evidence.pinnedGraph === "loading"
      ? "Loading the graph this run used."
      : null,
    evidence.inProgress
      ? `This run is in progress. Its evidence refreshes every ${RUN_POLL_MS / 1000} seconds.`
      : null,
  ]);

  return (
    <div data-testid="run-node-evidence">
      {notices.length > 0 ? (
        <div className="space-y-2 px-4 pt-3">
          {notices.map((notice) => (
            <Notice key={notice}>{notice}</Notice>
          ))}
        </div>
      ) : null}

      {shown === null ? (
        <Section title="Executions">
          <p className="text-muted-foreground text-xs">
            {evidence.inProgress
              ? "This step has not run yet."
              : "This step did not run in this run."}
          </p>
        </Section>
      ) : (
        <>
          <Section
            title={
              executions.length > 1
                ? `Execution ${executionNumber} of ${executions.length}`
                : "Execution"
            }
          >
            {executions.length > 1 ? (
              <ExecutionList
                executions={executions}
                onChoose={onChooseExecution}
                shown={shown}
              />
            ) : null}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground text-xs leading-5">
                Status
              </dt>
              <dd
                className={cn(
                  "leading-5",
                  statusToneTextClass(nodeStatusTone(shown.status))
                )}
              >
                {nodeStatusLabel(shown.status)}
              </dd>
              <dt className="text-muted-foreground text-xs leading-5">
                Started
              </dt>
              <dd className="leading-5">{formatTime(shown.startedAt)}</dd>
              <dt className="text-muted-foreground text-xs leading-5">
                Finished
              </dt>
              <dd className="leading-5">
                {shown.completedAt
                  ? formatTime(shown.completedAt)
                  : "Not finished"}
              </dd>
              <dt className="text-muted-foreground text-xs leading-5">
                Duration
              </dt>
              <dd className="font-mono leading-5 tabular-nums">
                {shown.duration ? formatDuration(shown.duration) : "None"}
              </dd>
            </dl>
            {unfinished ? (
              <p className="text-info text-xs">
                {evidence.inProgress
                  ? "This execution has not finished, so its record is incomplete."
                  : "The run ended before this execution recorded a finish."}
              </p>
            ) : null}
            <p className="text-muted-foreground text-xs">
              Retries inside one execution are shown as that execution&apos;s
              final outcome.
            </p>
          </Section>

          {shown.status === "error" && shown.error ? (
            <Section title="Error">
              <p className="break-words text-destructive text-sm">
                {shown.error}
              </p>
            </Section>
          ) : null}

          {shown.status === "cancelled" ? (
            <Section title="Cancellation">
              {shown.error ? (
                <p className="break-words text-cancelled text-sm">
                  {shown.error}
                </p>
              ) : null}
              {evidence.cancellation ? (
                <p className="text-muted-foreground text-xs">
                  {evidence.cancellation.message} ·{" "}
                  {formatTime(evidence.cancellation.createdAt)}
                </p>
              ) : null}
            </Section>
          ) : null}
        </>
      )}

      {evidence.waits.length > 0 ? (
        <Section title="Wait">
          {evidence.waits.map((wait) => (
            <div className="space-y-1.5" key={wait.id}>
              <p className="break-words text-sm">{waitingSummary(wait)}</p>
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
        </Section>
      ) : null}

      <Section title="Activity">
        {evidence.activity.length > 0 ? (
          <ol className="space-y-1.5">
            {evidence.activity.map((event) => (
              <li
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
                key={event.id}
              >
                <span className="break-words text-sm">{event.message}</span>
                <span className="text-muted-foreground text-xs">
                  {formatTime(event.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground text-xs">
            No activity was recorded for this step.
          </p>
        )}
      </Section>

      {shown ? (
        <>
          <Section title="Result">
            {isNotNil(shown.output) ? (
              <OutputDisplay
                actionType={shown.nodeType}
                input={shown.input}
                output={shown.output}
              />
            ) : (
              <p className="text-muted-foreground text-xs">
                No result was recorded.
              </p>
            )}
          </Section>
          <Payload
            emptyText="No input was recorded."
            title="Input"
            value={shown.input}
          />
          <Payload
            emptyText="No output was recorded."
            title="Output"
            value={shown.output}
          />
        </>
      ) : null}

      {evidence.config ? (
        <Payload
          emptyText="No configuration was recorded."
          title="Configuration"
          value={evidence.config}
        />
      ) : (
        <Section title="Configuration">
          <p className="text-muted-foreground text-xs">
            {evidence.pinnedGraph === "loading"
              ? "Loading the configuration this run used."
              : "The configuration this run used is unavailable."}
          </p>
        </Section>
      )}
    </div>
  );
}
