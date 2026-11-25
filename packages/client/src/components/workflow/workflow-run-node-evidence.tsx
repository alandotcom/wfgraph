import { useAtomValue } from "jotai";
import { Check, ChevronRight, X } from "lucide-react";
import { useState } from "react";
import { compact } from "es-toolkit/array";
import { isNotNil } from "es-toolkit/predicate";
import { cn } from "@wfgraph/shared/utils";
import { getConditionBranchDisplayLabel } from "@wfgraph/shared/conditions/condition-branch";
import { reconcileModelWithFields } from "@wfgraph/shared/conditions/conditions";
import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import { getNodeDisplayName } from "@wfgraph/shared/graph/node-display";
import { referenceFieldLabel } from "@wfgraph/shared/graph/node-references";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import { Button } from "#src/components/ui/button";
import type { ExecutionLog } from "#src/lib/execution-logs";
import { formatExactTime } from "@wfgraph/shared/utils/time";
import type { RunNodeEvidenceStatus } from "@wfgraph/shared/graph/group-run-status";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import type {
  ComparedValue,
  ConditionDecision,
  ConditionRuleEvidence,
} from "#src/lib/condition-decision";
import type { RunNodeEvidence } from "#src/lib/run-node-evidence";
import { getUpstreamConditionFields } from "#src/lib/upstream-node-fields";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { ConditionSummary } from "./config/condition-summary";
import { conditionLogicSentence } from "./canvas-reveal/condition-reveal-summary";
import {
  finishedRetriesSummary,
  nodeRetrySummary,
} from "#src/lib/run-executor-activity";
import { Section } from "./canvas-reveal/reveal-sections";
import { RUN_POLL_MS } from "./use-workflow-runs";
import { waitingSummary } from "./workflow-run-detail";
import { RunFailureText } from "./workflow-run-failure";
import { testRunSkip } from "#src/lib/test-run-skip";
import {
  CopyButton,
  formatDuration,
  JSON_PRE_CLASS,
  JsonPropertyInspector,
  RecordedValue,
  statusToneTextClass,
  stepRunStatusLabel,
  JsonWithLinks,
  OutputDisplay,
  useHasOutputDisplay,
} from "./workflow-run-shared";

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

/**
 * The recorded JSON behind one **Show raw data** disclosure: the compiled
 * expression, the input, the output and the configuration exactly as stored,
 * each with its Copy button, for a developer.
 */
function RawData({
  input,
  output,
  config,
  configNote,
}: {
  input: unknown;
  output: unknown;
  config: Readonly<Record<string, unknown>> | null;
  /** What stands in for the configuration when the pinned graph lacks it. */
  configNote: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-t px-4 py-3">
      <Button
        aria-expanded={open}
        className="-ml-2"
        onClick={() => setOpen(!open)}
        size="sm"
        type="button"
        variant="ghost"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 text-muted-foreground transition-transform duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
            open && "rotate-90"
          )}
        />
        {open ? "Hide raw data" : "Show raw data"}
      </Button>
      {open ? (
        <div className="-mx-4" data-slot="run-evidence-raw-data">
          <Payload
            emptyText="No input was recorded."
            title="Input"
            value={input}
          />
          <Payload
            emptyText="No output was recorded."
            title="Output"
            value={output}
          />
          {config ? (
            <Payload
              emptyText="No configuration was recorded."
              title="Configuration"
              value={config}
            />
          ) : (
            <Section title="Configuration">
              <p className="text-muted-foreground text-xs">{configNote}</p>
            </Section>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The labels an action's catalog entry gives the keys of its recorded input,
 * from its config fields, and of its recorded output, from its top-level
 * output fields. A key the catalog does not name reads as itself, made
 * readable.
 */
function actionFieldLabels(
  catalog: ExtensionCatalog,
  actionType: string
): { input: ReadonlyMap<string, string>; output: ReadonlyMap<string, string> } {
  const action = findAction(catalog, actionType);
  return {
    input: new Map(
      flattenConfigFields(action?.configFields ?? []).map((field) => [
        field.key,
        field.label,
      ])
    ),
    output: new Map(
      (action?.outputFields ?? [])
        .filter((field) => !field.path.includes("."))
        .map((field) => [field.path, referenceFieldLabel(field)])
    ),
  };
}

/** A recorded input or output as labeled values, or a line saying none was. */
function LabeledValues({
  title,
  value,
  labels,
  nodes,
  emptyText,
}: {
  title: string;
  value: unknown;
  labels: ReadonlyMap<string, string>;
  nodes: readonly WorkflowNode[];
  emptyText: string;
}) {
  return (
    <Section title={title}>
      {isNotNil(value) ? (
        <JsonPropertyInspector labels={labels} nodes={nodes} value={value} />
      ) : (
        <p className="text-muted-foreground text-xs">{emptyText}</p>
      )}
    </Section>
  );
}

/** "A", "A and B", or "A, B, and C". */
function listOfNames(names: readonly string[]): string {
  return new Intl.ListFormat("en", { type: "conjunction" }).format(names);
}

/** What a run recorded about one rule: whether it matched, and its value. */
function RuleEvidenceLine({
  evidence,
}: {
  evidence: ConditionRuleEvidence | undefined;
}) {
  if (evidence === undefined) {
    return null;
  }
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground text-xs">
      {evidence.matched === null ? null : (
        <span className="inline-flex items-center gap-1 text-foreground">
          {evidence.matched ? (
            <Check aria-hidden="true" className="size-3" strokeWidth={2.5} />
          ) : (
            <X aria-hidden="true" className="size-3" strokeWidth={2.5} />
          )}
          {evidence.matched ? "Matched" : "Did not match"}
        </span>
      )}
      <ComparedValueText compared={evidence.compared} />
      {evidence.decisive ? (
        <span className="font-medium text-foreground">Decided the branch</span>
      ) : null}
    </p>
  );
}

function ComparedValueText({ compared }: { compared: ComparedValue }) {
  if (compared.kind === "missing") {
    return <span>Not set in this run</span>;
  }
  if (compared.kind === "unrecorded") {
    // The run keeps no record of this value, which is not the same as the
    // value being absent when the rule was tested.
    return <span>Value not recorded</span>;
  }
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      Value in this run:
      <span className="text-foreground">
        <RecordedValue value={compared.value} />
      </span>
    </span>
  );
}

/**
 * A Condition's execution read as the decision it made: the branch it took
 * and where that branch continues, then each rule as the sentence the editor
 * builds for it, with whether the rule matched and the value it compared
 * where the run recorded them.
 */
function ConditionDecisionSections({
  nodeId,
  decision,
}: {
  nodeId: string;
  decision: ConditionDecision;
}) {
  const catalog = useExtensionCatalog();
  const graph = useAtomValue(executionOverlayGraphAtom);
  const nodes = graph?.nodes ?? [];
  const fields = getUpstreamConditionFields({
    currentNodeId: nodeId,
    nodes,
    edges: graph?.edges ?? [],
    catalog,
  });
  const targets = compact(
    decision.continuesTo.map((targetId) => {
      const target = nodes.find((node) => node.id === targetId);
      return target ? getNodeDisplayName(catalog, target) : null;
    })
  );
  const model =
    decision.model === null
      ? null
      : reconcileModelWithFields(
          decision.model,
          new Map(fields.map((field) => [field.path, field]))
        );
  return (
    <>
      <Section title="Decision">
        <p className="font-medium text-sm">
          Took {getConditionBranchDisplayLabel(decision.branch)}
        </p>
        <p className="text-sm">
          {targets.length > 0
            ? `Continues to ${listOfNames(targets)}.`
            : "The path ends here."}
        </p>
      </Section>
      <Section title="Rules">
        {model === null ? (
          <p className="text-muted-foreground text-xs">
            The rules this run used can't be read.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm">{conditionLogicSentence(model)}</p>
            <ConditionSummary
              fields={fields}
              model={model}
              nodes={nodes}
              ruleDetails={
                new Map(
                  [...decision.rules].map(([ruleId, evidence]) => [
                    ruleId,
                    <RuleEvidenceLine evidence={evidence} key={ruleId} />,
                  ])
                )
              }
            />
          </div>
        )}
      </Section>
    </>
  );
}

/**
 * Any other step's execution read in words: its integration's own display of
 * the result where it has one, then the input and the output as labeled
 * values under the action's field labels.
 */
function StepValueSections({ execution }: { execution: ExecutionLog }) {
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(executionOverlayGraphAtom)?.nodes ?? [];
  const hasOutputDisplay = useHasOutputDisplay(
    execution.nodeType,
    execution.output
  );
  const labels = actionFieldLabels(catalog, execution.nodeType);
  return (
    <>
      {/* A failed step's result repeats the error the Error section states. */}
      {hasOutputDisplay && execution.status !== "error" ? (
        <Section title="Result">
          <OutputDisplay
            actionType={execution.nodeType}
            input={execution.input}
            output={execution.output}
          />
        </Section>
      ) : null}
      <LabeledValues
        emptyText="No input was recorded."
        labels={labels.input}
        nodes={nodes}
        title="Input"
        value={execution.input}
      />
      <LabeledValues
        emptyText="No output was recorded."
        labels={labels.output}
        nodes={nodes}
        title="Output"
        value={execution.output}
      />
    </>
  );
}

function ExecutionList({
  executions,
  statuses,
  runMode,
  shown,
  onChoose,
}: {
  executions: readonly ExecutionLog[];
  /** The status of each execution, in the order of `executions`. */
  statuses: readonly RunNodeEvidenceStatus[];
  runMode: "live" | "test";
  shown: ExecutionLog;
  onChoose: (logId: string) => void;
}) {
  return (
    <ul aria-label="Executions" className="space-y-1">
      {executions.map((execution, index) => {
        const status = stepRunStatusLabel(
          statuses[index] ?? execution.status,
          testRunSkip({
            runMode,
            status: execution.status,
            output: execution.output,
          }) !== null
        );
        return (
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
                <span className={statusToneTextClass(status.tone)}>
                  {status.text}
                </span>
                {execution.duration ? (
                  <span className="font-mono text-muted-foreground tabular-nums">
                    {formatDuration(execution.duration)}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The recorded evidence of one node in one run: its executions, timing, error or
 * cancellation, a step the executor is retrying, the wait it holds with
 * Resume, or Continue now for a timed Wait of a draft run, what it did in words, its activity, and its recorded input, output
 * and configuration as raw JSON behind **Show raw data**. A Condition says the
 * branch it took and each rule; any other step shows its input and output as
 * labeled values. An execution
 * is one time the run reached the node; a finished one says which try it
 * ended on when its steps were retried. Notices say
 * when the node is gone from the pinned graph, when that graph is loading or
 * unavailable, and when the run is still polling. Choosing an execution calls
 * `onChooseExecution` and nothing else.
 */
export function WorkflowRunNodeEvidence({
  evidence,
  isResuming,
  isContinuing,
  onChooseExecution,
  onResume,
  onContinueWait,
}: {
  evidence: RunNodeEvidence;
  isResuming: boolean;
  isContinuing: boolean;
  onChooseExecution: (logId: string) => void;
  onResume?: ((token: string) => void) | undefined;
  /** As on `WorkflowRunDetailProps`: present only for a run of the draft. */
  onContinueWait?: ((waitStateId: string) => void) | undefined;
}) {
  const catalog = useExtensionCatalog();
  const { shownExecution: shown, executions } = evidence;
  const status = stepRunStatusLabel(
    evidence.status,
    evidence.testSkip !== null
  );
  const executionNumber = shown ? executions.indexOf(shown) + 1 : 0;
  const unfinished =
    shown !== null &&
    (shown.status === "running" || shown.status === "pending");
  const retriesSummary = shown === null ? null : finishedRetriesSummary(shown);
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
                runMode={evidence.runMode}
                shown={shown}
                statuses={evidence.executionStatuses}
              />
            ) : null}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground text-xs leading-5">
                Status
              </dt>
              <dd className={cn("leading-5", statusToneTextClass(status.tone))}>
                {status.text}
              </dd>
              <dt className="text-muted-foreground text-xs leading-5">
                Started
              </dt>
              <dd className="leading-5">{formatExactTime(shown.startedAt)}</dd>
              <dt className="text-muted-foreground text-xs leading-5">
                Finished
              </dt>
              <dd className="leading-5">
                {shown.completedAt
                  ? formatExactTime(shown.completedAt)
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
            {evidence.testSkip === null ? null : (
              <p className="text-sm">{evidence.testSkip}</p>
            )}
            {retriesSummary === null ? null : (
              <p className="text-sm">{retriesSummary}</p>
            )}
          </Section>

          {shown.status === "error" && shown.error ? (
            <Section title="Error">
              <RunFailureText
                className="text-sm"
                error={shown.error}
                nodeId={evidence.nodeId}
              />
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
                  {formatExactTime(evidence.cancellation.createdAt)}
                </p>
              ) : null}
            </Section>
          ) : null}
        </>
      )}

      {evidence.retry === null ? null : (
        <Section title="Retry">
          <p className="text-sm text-warning">
            {nodeRetrySummary(evidence.retry)}
          </p>
          <p className="break-words text-muted-foreground text-xs">
            {evidence.retry.error}
          </p>
        </Section>
      )}

      {evidence.waits.length > 0 ? (
        <Section title="Wait">
          {evidence.waits.map((wait) => (
            <div className="space-y-1.5" key={wait.id}>
              <p className="break-words text-sm">
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
        </Section>
      ) : null}

      {shown === null ? null : evidence.condition ? (
        <ConditionDecisionSections
          decision={evidence.condition}
          nodeId={evidence.nodeId}
        />
      ) : (
        <StepValueSections execution={shown} />
      )}

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
                  {formatExactTime(event.createdAt)}
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

      {/* Keyed by the execution shown, so each step opens words first. */}
      <RawData
        config={evidence.config}
        key={`${evidence.nodeId}:${shown?.id ?? ""}`}
        configNote={
          evidence.pinnedGraph === "loading"
            ? "Loading the configuration this run used."
            : "The configuration this run used is unavailable."
        }
        input={shown?.input}
        output={shown?.output}
      />
    </div>
  );
}
