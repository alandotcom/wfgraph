/**
 * The engine's entry point: what a caller hands a run, and what the run leaves
 * behind once its graph is walked.
 *
 * The walk itself is `NodeScheduler`, whose state lives in `Traversal` and
 * `CancelBoundary`.
 */

import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type {
  SerializedWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
} from "@wfgraph/shared/graph/types";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { Cause, Effect } from "effect";
import type { WorkflowActions } from "#src/backend/engine/actions";
import {
  noWorkflowEntities,
  type WorkflowEntities,
} from "#src/backend/engine/entities";
import { CancelBoundary } from "#src/backend/engine/cancel-boundary";
import type {
  ExecutionResult,
  NodeOutputs,
} from "#src/backend/engine/contracts";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import {
  isPassParked,
  NodeScheduler,
  type NodeSchedulerInput,
  type PassParked,
} from "#src/backend/engine/scheduler";
import type {
  PendingCancel,
  StoreFailure,
  WorkflowStore,
} from "#src/backend/engine/store";
import { recordVerdict } from "#src/backend/engine/terminal-record";
import type {
  CanceledOutletOutcome,
  RunEndAnswer,
  RunExitContext,
  RunVerdict,
} from "@wfgraph/shared/lifecycle/run-ending";
import { Traversal } from "#src/backend/engine/traversal";
import {
  endsPass,
  type EngineFailure,
  failureFromCause,
  failureFromUnknown,
} from "#src/backend/engine/engine-failure";
import { runDurable } from "#src/backend/engine/durable";
import { withAppLogCategory } from "#src/backend/lib/effect/app-logger";
import { entityEligibilityConditionId } from "#src/backend/lib/entity-eligibility";
import { readLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowExecutionStatus } from "@wfgraph/shared/lifecycle/execution-contracts";

export type { WorkflowActions } from "#src/backend/engine/actions";
export type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
export type { WorkflowStore } from "#src/backend/engine/store";

/** A graph's nodes and edges, parsed from its serialized form. */
export type WorkflowGraphData = {
  readonly nodes: WorkflowNode[];
  readonly edges: WorkflowEdge[];
};

export type WorkflowExecutionInput = {
  graph: SerializedWorkflowGraph;
  /**
   * `graph`'s nodes and edges already parsed, from a caller that keeps them
   * with the version so the passes of one version share one parse. Parsed
   * from `graph` when absent. The engine reads them and never writes them.
   */
  parsedGraph?: WorkflowGraphData | undefined;
  /** The published version this run pins. */
  workflowVersionId: string;
  /**
   * Catalog fingerprint at publish. Compared against the live catalog when an
   * action resolves, so drift fails the node once.
   */
  catalogFingerprint: string;
  /**
   * The payload that set this run going: a manual-run input, or the payload a
   * Start Event arrived with. It reached the engine as JSON and is written back
   * out as JSON into `workflow_executions.input`.
   */
  startPayload?: JsonObject | undefined;
  /**
   * The Event that started the run, absent for a manual start and for the
   * execute route. A Condition node reads it as the Event the run arrived on
   * until an event-mode Wait resumes or a Cancel Event takes the run to the
   * Canceled outlet.
   */
  startEventName?: string | undefined;
  /** The untouched payload as it arrived, before any mock request filled in. */
  requestPayload?: JsonObject | undefined;
  /**
   * Identifies the run row every log, timeline event, and wait state hangs off.
   * Required: whether a run leaves a trace is decided by which `WorkflowStore`
   * the caller injects, never by omitting an id here.
   */
  executionId: string;
  /** Owning workflow. Also how steps look up integration credentials. */
  workflowId: string;
  workflowName?: string | undefined;
  /** Immutable typed identity selected when a guarded Execution was opened. */
  entityType?: string | undefined;
  entityId?: string | undefined;
  runMode?: "live" | "test" | undefined;
};

/** What one call of the engine builds before it can execute a node. */
type PreparedRun = {
  nodes: readonly WorkflowNode[];
  edgeCount: number;
  traversal: Traversal;
  cancelBoundary: CancelBoundary;
  scheduler: NodeScheduler;
  lifecycleNodeIds: string[];
  entityEligibility?: NodeSchedulerInput["entityEligibility"];
};

/** What the run's nodes left behind in this pass, which every result carries. */
type RunProgress = {
  results: Readonly<Record<string, ExecutionResult>>;
  outputs: Readonly<NodeOutputs>;
};

/**
 * What one pass of the body answers: the run ended with its terminal record
 * written, or the pass ended with at least one Wait parked.
 */
type WorkflowExecutionResult = EndedWorkflowExecution | ParkedWorkflowExecution;

/**
 * A pass of the body that ended with at least one Wait parked, and wrote no
 * terminal record. `openParks` counts those Waits, and `status` is what the
 * execution row holds while parked. The run has no verdict yet.
 */
type ParkedWorkflowExecution = RunProgress & {
  kind: "parked";
  openParks: number;
  status: "waiting";
};

/** A pass of the body that wrote the run's terminal record. */
type EndedWorkflowExecution = RunProgress & {
  kind: "ended";
  status: WorkflowExecutionStatus;
  success: boolean;
  error?: string | undefined;
  cancelled?: boolean | undefined;
};

/**
 * Builds the traversal, the cancel boundary and the scheduler one run walks
 * with.
 */
function prepareRun(
  input: WorkflowExecutionInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions,
  entities: WorkflowEntities
): PreparedRun {
  const {
    graph,
    startPayload = {},
    startEventName = null,
    executionId,
    workflowId,
    runMode = "live",
  } = input;
  const { nodes, edges } = input.parsedGraph ?? toWorkflowGraphData(graph);

  const traversal = new Traversal(nodes, edges);
  const lifecycleNodes = traversal.lifecycleNodes;
  const lifecycleRules = readLifecycleRules(lifecycleNodes[0]?.data.config);
  const eligibility = lifecycleRules?.entityEligibility;
  const trackedEntity = lifecycleRules?.trackedEntity
    ? {
        entityType: input.entityType ?? "",
        entityId: input.entityId ?? "",
      }
    : undefined;
  const entityEligibility = eligibility?.checkpoints.includes("before-node")
    ? {
        entityType: input.entityType ?? "",
        entityId: input.entityId ?? "",
        condition: eligibility.condition,
        conditionId: entityEligibilityConditionId(eligibility.condition),
      }
    : undefined;

  const cancelBoundary = new CancelBoundary({
    edges,
    traversal,
    runtime,
    store,
    executionId,
    lifecycleNodes,
  });

  const scheduler = new NodeScheduler({
    traversal,
    cancelBoundary,
    runtime,
    store,
    actions,
    entities,
    executionId,
    workflowId,
    runMode,
    startPayload,
    startEventName,
    catalogFingerprint: input.catalogFingerprint,
    workflowVersionId: input.workflowVersionId,
    trackedEntity,
    entityEligibility,
  });

  return {
    nodes,
    edgeCount: edges.length,
    traversal,
    cancelBoundary,
    scheduler,
    lifecycleNodeIds: lifecycleNodes.map((node) => node.id),
    entityEligibility,
  };
}

/**
 * Which run a record belongs to, as one field rather than six.
 *
 * The pretty formatter prints a line per top-level field, so flat keys cost a
 * line each on every record the run writes. Grouped they cost one, and the JSON
 * line carries the group as a nested object a log store addresses as
 * `run.execution`.
 *
 * Two of these. The ambient one rides on every record and carries only what
 * correlates it, because a full identity repeated on each line is as wide as a
 * terminal. The full one is written once, on the record that opens the run.
 */
function runLogAnnotations(
  input: WorkflowExecutionInput
): Record<string, unknown> {
  return { run: { execution: input.executionId } };
}

function runIdentity(input: WorkflowExecutionInput): Record<string, unknown> {
  return {
    run: {
      workflow: input.workflowId,
      workflowName: input.workflowName ?? null,
      execution: input.executionId,
      mode: input.runMode ?? "live",
    },
  };
}

function workflowSpanAttributes(
  input: WorkflowExecutionInput
): Record<string, string> {
  return omitUndefined({
    "wfgraph.workflow.id": input.workflowId,
    "wfgraph.execution.id": input.executionId,
    "wfgraph.workflow.name": input.workflowName,
    "wfgraph.execution.run_mode": input.runMode ?? "live",
  });
}

/**
 * All three ports are required. `runtime` decides how work is made durable,
 * `store` decides where the run's trace is written, and `actions` decides what
 * an action id dispatches to. None of them defaults, because a port that
 * silently does nothing reads to the caller as a working run: omitting `store`
 * would complete green having persisted nothing. The executor's run body in
 * `executor/run-body.ts` is where a real run picks up all three.
 */
export function executeWorkflow(
  input: WorkflowExecutionInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions,
  entities: WorkflowEntities = noWorkflowEntities
): Effect.Effect<WorkflowExecutionResult, EngineFailure> {
  const execute = executeWorkflowInner(
    input,
    runtime,
    store,
    actions,
    entities
  ).pipe(
    Effect.annotateLogs(runLogAnnotations(input)),
    Effect.withSpan("wfgraph.workflow.execution", {
      attributes: workflowSpanAttributes(input),
    })
  );
  return withAppLogCategory(execute, "engine");
}

function executeWorkflowInner(
  input: WorkflowExecutionInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions,
  entities: WorkflowEntities
) {
  return Effect.suspend(() => {
    const { executionId, workflowId } = input;
    const {
      nodes,
      edgeCount,
      traversal,
      cancelBoundary,
      scheduler,
      lifecycleNodeIds,
      entityEligibility,
    } = prepareRun(input, runtime, store, actions, entities);

    const exitContext: RunExitContext | undefined =
      entityEligibility?.entityType
        ? {
            entityType: entityEligibility.entityType,
            conditionId: entityEligibility.conditionId,
          }
        : undefined;

    // This body is re-run on every attempt and after every wait, so this clock
    // measures the current attempt alone. The run's own elapsed is derived from
    // its stored `started_at` where the row is closed.
    const attemptStartTime = Date.now();

    const execute = Effect.gen(function* () {
      // The two payloads used to ride here. Either one is as large as the Event
      // that carried it, and the execution row stores both, so the log names
      // the graph it is about to walk and leaves the payload to the database.
      yield* Effect.logInfo(
        `Run started: ${input.workflowName ?? workflowId} (${nodes.length} nodes)`
      ).pipe(
        Effect.annotateLogs({
          ...runIdentity(input),
          graph: {
            nodes: nodes.length,
            edges: edgeCount,
            lifecycle: lifecycleNodeIds,
          },
        })
      );
      yield* scheduler.runAll(lifecycleNodeIds);
      // Every Wait the fan-out reached was held back, so the branches that
      // suspend nothing are finished by now and the run may park. A Wait left
      // parked ends the pass here: the outcome read below is memoized, so
      // reading it while a Wait is parked would give the pass in which the park
      // resolves a stale answer.
      yield* scheduler.settle();

      const termination = yield* runDurable(
        runtime,
        {
          id: "execution-termination-final",
          name: "Read run outcome",
          nodeId: null,
        },
        store.readTerminationState(executionId)
      );
      // A Cancel claim that landed after the last node's boundary read found no
      // node left to route it, so the run takes the Canceled outlet here. The
      // read is memoized, so a replay enters the outlet at the same point, and
      // each outlet node's durable steps answer from the memo.
      if (
        termination?.claim?.kind === "cancel" &&
        !cancelBoundary.hasLeftStartedBranch()
      ) {
        yield* scheduler.runCanceledOutlet({
          eventName: termination.claim.eventName,
          payload: termination.claim.payload,
        });
      }
    });

    return Effect.gen(function* () {
      const outcome = yield* execute.pipe(
        Effect.as({ kind: "completed" as const }),
        // A walk that settled parked is no failure of the run, so it passes on
        // to the one place below that ends a pass parked.
        Effect.catchCauseIf(
          (cause) => !isPassParked(cause),
          (cause) => Effect.succeed({ kind: "failed" as const, cause })
        )
      );

      if (outcome.kind === "failed") {
        const failure = failureFromCause(outcome.cause);

        // An interrupted pass is one the executor runs again, and that pass
        // replays the memoized steps, reads the claim at the terminal read and
        // runs the Canceled outlet from there. A terminal status written by
        // this dying pass would leave the next one reading a row that is no
        // longer in flight, so the pass ends the way it was interrupted and
        // writes nothing. A pass that lost its lease ends the same way, leaving
        // the run to the owner that holds it now, and so does a pass a version
        // fence refused, leaving the run to the pass that loads the version it
        // was moved to. The executor logs how the pass ended, so none of these
        // is logged as a fatal error here.
        if (endsPass(failure)) {
          return yield* Effect.failCause(outcome.cause);
        }

        yield* Effect.logError("Fatal error during workflow execution").pipe(
          Effect.annotateLogs({
            error: { kind: failure.kind, cause: Cause.squash(outcome.cause) },
          })
        );

        // The flag is the authority here as it is on the success path: a run is
        // canceled because a Cancel Event claimed it, never because the text of
        // whatever died happens to contain the word.
        const cancelled = cancelBoundary.hasLeftStartedBranch();

        const recordFailure = (canceledOutlet?: CanceledOutletOutcome) =>
          recordAndReport({
            store,
            executionId,
            verdict: fatalVerdict(failure, exitContext, canceledOutlet),
          });

        // Same exactly-once treatment as the success path. A refusal here
        // escapes so the durable step can retry instead of being mistaken for
        // another traversal failure.
        const failedRecord = yield* runDurable(
          runtime,
          { id: "workflow-run-failed", name: "Run failed", nodeId: null },
          recordFailure(cancelled ? "entered" : undefined)
        );

        // A Cancel claim the terminal write was the first to see refused the
        // `workflow-run-failed` record, which wrote nothing and memoized the
        // claim. Every claimed Execution jumps to the Canceled outlet
        // (ADR-0007), so the outlet runs for that claim and a step of its own
        // records canceled after it.
        const recorded =
          failedRecord.answer.kind === "cancel_claimed"
            ? yield* runCanceledOutletThenRecord({
                runtime,
                scheduler,
                claim: failedRecord.answer.cancel,
                record: recordFailure,
              })
            : failedRecord;

        return {
          kind: "ended" as const,
          status: recorded.status,
          success: recorded.status !== "failed",
          results: traversal.results,
          outputs: traversal.outputs,
          error: recorded.status === "failed" ? failure.message : undefined,
          cancelled: recorded.status === "canceled" || cancelled,
        };
      }

      // The output, failure and count are read when each step is built, so the
      // record written after the Canceled outlet runs includes that outlet.
      const recordCompletion = (
        canceled: boolean,
        canceledOutlet?: "ran" | "failed"
      ) =>
        recordAndReport({
          store,
          executionId,
          verdict: walkedVerdict({
            traversal,
            canceled,
            exitContext,
            canceledOutlet,
          }),
          output: traversal.deterministicTerminalOutput(),
        });

      // Wrapped as a durable step so the terminal record and its audit event are
      // written exactly once, even though the body replays after every wait. A
      // refusal escapes the traversal catch above and lets this step retry.
      const completed = yield* runDurable(
        runtime,
        { id: "workflow-run-completed", name: "Run completed", nodeId: null },
        recordCompletion(cancelBoundary.hasLeftStartedBranch())
      );

      // A Cancel claim that landed after the outcome read refused the record
      // written just above, which wrote nothing and memoized the claim. The run
      // takes the Canceled outlet for that claim and records canceled in a step
      // of its own, so the outlet's nodes run before the terminal row ends the
      // run.
      const recorded =
        completed.answer.kind === "cancel_claimed"
          ? yield* runCanceledOutletThenRecord({
              runtime,
              scheduler,
              claim: completed.answer.cancel,
              record: (outlet) => recordCompletion(true, outlet),
            })
          : completed;

      const attemptMs = Date.now() - attemptStartTime;
      yield* Effect.logInfo(`Run ${recorded.status} in ${attemptMs}ms`).pipe(
        Effect.annotateLogs({
          outcome: {
            status: recorded.status,
            success: recorded.status !== "failed",
            nodes: traversal.resultCount,
            ms: attemptMs,
          },
        })
      );

      return {
        kind: "ended" as const,
        status: recorded.status,
        success: recorded.status !== "failed",
        results: traversal.results,
        outputs: traversal.outputs,
      };
    }).pipe(
      // The one exit of a pass that parked. A walk settled with a Wait parked,
      // before the outcome read and before any terminal or canceled record.
      Effect.catchTag("PassParked", () =>
        endParked({ store, executionId, traversal, attemptStartTime })
      )
    );
  });
}

/**
 * Ends a pass of the body that left at least one Wait parked, and writes no
 * terminal record.
 *
 * A Wait that resumed in this pass may have moved the execution row to
 * `running` while a sibling stayed parked, so the row is moved back to
 * `waiting`. The write applies only while some wait row is still waiting. It is
 * not a memoized step, because every pass that ends parked has to make it.
 */
function endParked(input: {
  store: WorkflowStore;
  executionId: string;
  traversal: Traversal;
  attemptStartTime: number;
}): Effect.Effect<ParkedWorkflowExecution, EngineFailure> {
  return Effect.gen(function* () {
    const { store, executionId, traversal } = input;

    yield* store
      .markExecutionWaitingIfParked({ executionId })
      .pipe(Effect.mapError(failureFromUnknown));

    const openParks = traversal.openParkCount;
    const attemptMs = Date.now() - input.attemptStartTime;
    yield* Effect.logInfo(
      `Run parked on ${openParks} Wait${openParks === 1 ? "" : "s"} in ${attemptMs}ms`
    ).pipe(
      Effect.annotateLogs({
        outcome: {
          status: "waiting",
          parks: openParks,
          nodes: traversal.resultCount,
          ms: attemptMs,
        },
      })
    );

    return {
      kind: "parked",
      openParks,
      status: "waiting",
      results: traversal.results,
      outputs: traversal.outputs,
    };
  });
}

/**
 * Runs the Canceled outlet for a Cancel claim that refused a terminal record,
 * then writes the canceled record its caller built, as a durable step.
 *
 * Both terminal paths reach this, so both treat a dying outlet the same way. An
 * outlet that raises a defect still ends the run: `record` is called with
 * `failed` and the audit row says the outlet died partway. An interrupt is no
 * outlet failure: the cause is re-raised, the pass ends with nothing written,
 * and the next pass the executor runs takes the outlet. A lost
 * lease, a refused version fence and an outlet that left a Wait parked are
 * re-raised the same way, and end the pass before the record.
 *
 * The step id is shared with whichever terminal path did not call this. An
 * execution takes one of the two paths, and a replay takes the path it took
 * before, so the two never claim the id inside one run.
 */
function runCanceledOutletThenRecord<A, E>(input: {
  runtime: WorkflowExecutionRuntime;
  scheduler: NodeScheduler;
  claim: PendingCancel;
  record: (outlet: "ran" | "failed") => Effect.Effect<A, E>;
}): Effect.Effect<A, EngineFailure | PassParked> {
  return Effect.gen(function* () {
    const outlet = yield* input.scheduler.runCanceledOutlet(input.claim).pipe(
      Effect.as("ran" as const),
      Effect.catchCause((outletCause) => {
        const outletFailure = failureFromCause(outletCause);
        return isPassParked(outletCause) || endsPass(outletFailure)
          ? Effect.failCause(outletCause)
          : Effect.logError("The Canceled outlet failed").pipe(
              Effect.annotateLogs({
                error: {
                  kind: outletFailure.kind,
                  cause: Cause.squash(outletCause),
                },
              }),
              Effect.as("failed" as const)
            );
      })
    );
    return yield* runDurable(
      input.runtime,
      { id: "workflow-run-canceled", name: "Run canceled", nodeId: null },
      input.record(outlet)
    );
  });
}

/**
 * Records `verdict` and pairs the store's answer with the status the pass
 * reports: the stored status once the run has ended, and the verdict's while
 * a claim holds the run.
 */
function recordAndReport(input: {
  store: WorkflowStore;
  executionId: string;
  verdict: RunVerdict;
  output?: unknown;
}): Effect.Effect<
  { answer: RunEndAnswer; status: WorkflowExecutionStatus },
  StoreFailure
> {
  return recordVerdict(input).pipe(
    Effect.map((answer) => ({
      answer,
      status:
        answer.kind === "ended" || answer.kind === "already_ended"
          ? answer.status
          : input.verdict.status,
    }))
  );
}

/**
 * The verdict of a traversal that walked the graph to its end. A run that left
 * the Started branch is canceled, and otherwise its first failed node decides
 * between failed and completed.
 */
function walkedVerdict(input: {
  traversal: Traversal;
  canceled: boolean;
  exitContext: RunExitContext | undefined;
  canceledOutlet?: "ran" | "failed" | undefined;
}): RunVerdict {
  const { traversal, exitContext } = input;
  const resultCount = traversal.resultCount;
  const failure = traversal.firstFailure();
  if (input.canceled) {
    return {
      kind: "verdict",
      status: "canceled",
      exitContext,
      reached: {
        kind: "walked",
        resultCount,
        error: failure?.message,
        canceledOutlet: input.canceledOutlet,
      },
    };
  }
  return failure
    ? {
        kind: "verdict",
        status: "failed",
        exitContext,
        reached: { kind: "walked", resultCount, error: failure.message },
      }
    : {
        kind: "verdict",
        status: "completed",
        exitContext,
        reached: { kind: "walked", resultCount },
      };
}

/**
 * The verdict of an error that escaped the traversal: canceled when the run
 * had taken or then ran the Canceled outlet, and failed otherwise.
 */
function fatalVerdict(
  failure: EngineFailure,
  exitContext: RunExitContext | undefined,
  canceledOutlet: CanceledOutletOutcome | undefined
): RunVerdict {
  const reached = {
    kind: "fatal",
    error: failure.message,
    failureKind: failure.kind,
  } as const;
  return canceledOutlet
    ? {
        kind: "verdict",
        status: "canceled",
        exitContext,
        reached: { ...reached, canceledOutlet },
      }
    : { kind: "verdict", status: "failed", exitContext, reached };
}
