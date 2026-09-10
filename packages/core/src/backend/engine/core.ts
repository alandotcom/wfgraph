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
  WorkflowNode,
} from "@wfgraph/shared/graph/types";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { Cause, Effect } from "effect";
import type { WorkflowActions } from "#src/backend/engine/actions";
import type { BranchRunResult } from "#src/backend/engine/branch";
import {
  noWorkflowEntities,
  type WorkflowEntities,
} from "#src/backend/engine/entities";
import { CancelBoundary } from "#src/backend/engine/cancel-boundary";
import {
  type ExecutionResult,
  type NodeOutputs,
  wrapStoredOutput,
} from "#src/backend/engine/contracts";
import type {
  DurableStepRef,
  WorkflowExecutionRuntime,
} from "#src/backend/engine/runtime";
import {
  NodeScheduler,
  type NodeSchedulerInput,
} from "#src/backend/engine/scheduler";
import type { WorkflowStore } from "#src/backend/engine/store";
import {
  recordRunCompleted,
  recordRunFailed,
  type TraversalTerminalStatus,
} from "#src/backend/engine/terminal-record";
import { Traversal } from "#src/backend/engine/traversal";
import {
  type EngineFailure,
  engineFailure,
  failureFromCause,
} from "#src/backend/engine/engine-failure";
import { runDurable, runDurableUnit } from "#src/backend/engine/durable";
import { withAppLogCategory } from "#src/backend/lib/effect/app-logger";
import { entityEligibilityConditionId } from "#src/backend/lib/entity-eligibility";
import { readLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type {
  EntityEligibilityReason,
  WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";

export type { WorkflowActions } from "#src/backend/engine/actions";
export type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
export type { WorkflowStore } from "#src/backend/engine/store";

export type WorkflowExecutionInput = {
  graph: SerializedWorkflowGraph;
  /** The published version this run pins. */
  workflowVersionId: string;
  /**
   * Catalog fingerprint at publish. Compared against the live catalog when an
   * action resolves, so drift fails the node once.
   */
  catalogFingerprint: string;
  /**
   * The payload that set this run going: a manual-run input, or the data on the
   * Inngest event a Start Event arrived as. It reached the engine as JSON and is
   * written back out as JSON into `workflow_executions.input`.
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
  workflowRunId?: string | undefined;
  runMode?: "live" | "test" | undefined;
};

/**
 * A run of the branch below one Wait node, which is a durable run of its own.
 *
 * Everything above the entry node ran in whichever run handed the branch off.
 * Its outputs reach this run through the store, and `releasedNodeIds` says which
 * of those nodes let their downstream follow, which the stored rows cannot: a
 * node that halted its branch has an output and released nothing.
 */
export type WorkflowBranchInput = WorkflowExecutionInput & {
  entryNodeId: string;
  releasedNodeIds: readonly string[];
  /** Wait entries of the durable branch invocations waiting on this branch. */
  ancestorEntryNodeIds: readonly string[];
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

type WorkflowExecutionResult = {
  status: WorkflowExecutionStatus;
  success: boolean;
  results: Readonly<Record<string, ExecutionResult>>;
  outputs: Readonly<NodeOutputs>;
  error?: string | undefined;
  cancelled?: boolean | undefined;
  exit?:
    | {
        reason: EntityEligibilityReason;
        entityType: string;
        conditionId: string;
        nodeId: string;
        checkedAt: string;
      }
    | undefined;
};

/**
 * Builds the traversal, the cancel boundary and the scheduler one run walks
 * with.
 *
 * A branch run names its entry node, and that is the whole of the difference
 * here: its cancel boundary is inert, because the run that started the branch is
 * the one that routes a cancellation and the branch itself is killed outright.
 */
function prepareRun(
  input: WorkflowExecutionInput | WorkflowBranchInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions,
  entities: WorkflowEntities
): PreparedRun {
  const branchEntryNodeId =
    "entryNodeId" in input ? input.entryNodeId : undefined;
  const {
    graph,
    startPayload = {},
    startEventName = null,
    executionId,
    workflowId,
    workflowRunId,
    runMode = "live",
  } = input;
  const { nodes, edges } = toWorkflowGraphData(graph);

  const currentWorkflowRunId = workflowRunId || runtime.runId || executionId;

  const traversal = new Traversal(nodes, edges);
  const lifecycleNodes = traversal.lifecycleNodes;
  const eligibility = readLifecycleRules(
    lifecycleNodes[0]?.data.config
  )?.entityEligibility;
  const entityEligibility = eligibility?.checkpoints.includes("before-node")
    ? {
        entityType: input.entityType ?? "",
        entityId: input.entityId ?? "",
        condition: eligibility.condition,
        conditionId: entityEligibilityConditionId(eligibility.condition),
      }
    : undefined;

  const boundaryInput = {
    edges,
    traversal,
    runtime,
    store,
    executionId,
  };
  const cancelBoundary = branchEntryNodeId
    ? CancelBoundary.inert(boundaryInput)
    : new CancelBoundary({ ...boundaryInput, lifecycleNodes });

  const scheduler = new NodeScheduler({
    traversal,
    cancelBoundary,
    runtime,
    store,
    actions,
    entities,
    executionId,
    workflowId,
    workflowRunId: currentWorkflowRunId,
    runMode,
    startPayload,
    startEventName,
    catalogFingerprint: input.catalogFingerprint,
    workflowVersionId: input.workflowVersionId,
    entityEligibility,
    branchEntryNodeId,
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
  input: WorkflowExecutionInput | WorkflowBranchInput,
  runtime: WorkflowExecutionRuntime
): Record<string, unknown> {
  return {
    run: {
      execution: input.executionId,
      id: input.workflowRunId || runtime.runId || input.executionId,
    },
  };
}

function runIdentity(
  input: WorkflowExecutionInput | WorkflowBranchInput,
  runtime: WorkflowExecutionRuntime
): Record<string, unknown> {
  return {
    run: {
      workflow: input.workflowId,
      workflowName: input.workflowName ?? null,
      execution: input.executionId,
      id: input.workflowRunId || runtime.runId || input.executionId,
      mode: input.runMode ?? "live",
      branchEntry: "entryNodeId" in input ? input.entryNodeId : null,
    },
  };
}

function workflowSpanAttributes(
  input: WorkflowExecutionInput | WorkflowBranchInput
): Record<string, string> {
  return omitUndefined({
    "wfgraph.workflow.id": input.workflowId,
    "wfgraph.execution.id": input.executionId,
    "wfgraph.workflow.name": input.workflowName,
    "wfgraph.execution.run_mode": input.runMode ?? "live",
  });
}

/**
 * Writes the terminal record for a run-level failure through `recordRunFailed`,
 * in one durable step. An Exit or Cancel claim already on the row wins, so the
 * Execution ends on that claim.
 */
function recordRunFailure(input: {
  run: WorkflowExecutionInput | WorkflowBranchInput;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  entityEligibility: NodeSchedulerInput["entityEligibility"];
  step: DurableStepRef;
  status: "failed" | "canceled";
  failure: EngineFailure;
}) {
  const { run, entityEligibility } = input;
  return runDurable(
    input.runtime,
    input.step,
    recordRunFailed({
      store: input.store,
      executionId: run.executionId,
      workflowId: run.workflowId,
      status: input.status,
      failure: input.failure,
      runMode: run.runMode ?? "live",
      exitContext: entityEligibility?.entityType
        ? {
            entityType: entityEligibility.entityType,
            conditionId: entityEligibility.conditionId,
          }
        : undefined,
    })
  );
}

/**
 * All three ports are required. `runtime` decides how work is made durable,
 * `store` decides where the run's trace is written, and `actions` decides what
 * an action id dispatches to. None of them defaults, because a port that
 * silently does nothing reads to the caller as a working run: omitting `store`
 * would complete green having persisted nothing. The Inngest adapter in
 * lib/inngest/workflow-function.ts is where a real run picks up all three.
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
    Effect.annotateLogs(runLogAnnotations(input, runtime)),
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
    const { executionId, workflowId, runMode = "live" } = input;
    const {
      nodes,
      edgeCount,
      traversal,
      cancelBoundary,
      scheduler,
      lifecycleNodeIds,
      entityEligibility,
    } = prepareRun(input, runtime, store, actions, entities);

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
          ...runIdentity(input, runtime),
          graph: {
            nodes: nodes.length,
            edges: edgeCount,
            lifecycle: lifecycleNodeIds,
          },
        })
      );
      yield* scheduler.runAll(lifecycleNodeIds);
      // Every Wait the fan-out reached was held back, so the branches that
      // suspend nothing are finished by now and the run may park.
      yield* scheduler.drainDeferredWaits();

      const finalSuccess = traversal.allSucceeded();
      const finalOutput = traversal.deterministicTerminalOutput();
      const termination = yield* runDurable(
        runtime,
        { id: "execution-termination-final", name: "Read run outcome" },
        store.readTerminationState(executionId)
      );
      const exitClaim =
        termination?.claim?.kind === "exit" ? termination.claim : undefined;
      const exitContext = entityEligibility?.entityType
        ? {
            entityType: entityEligibility.entityType,
            conditionId: entityEligibility.conditionId,
          }
        : undefined;
      // The persisted first claim outranks traversal results. Exit takes no
      // graph outlet; cancellation retains its distinct Canceled branch.
      const terminalStatus: TraversalTerminalStatus = exitClaim
        ? "exited"
        : cancelBoundary.hasLeftStartedBranch() ||
            termination?.claim?.kind === "cancel"
          ? "canceled"
          : finalSuccess
            ? "completed"
            : "failed";

      return { terminalStatus, finalOutput, exitContext };
    });

    return Effect.gen(function* () {
      const outcome = yield* execute.pipe(
        Effect.map((value) => ({ kind: "completed" as const, value })),
        Effect.catchCause((cause) =>
          Effect.succeed({ kind: "failed" as const, cause })
        )
      );

      if (outcome.kind === "failed") {
        const failure = failureFromCause(outcome.cause);
        yield* Effect.logError("Fatal error during workflow execution").pipe(
          Effect.annotateLogs({
            error: { kind: failure.kind, cause: Cause.squash(outcome.cause) },
          })
        );

        // The flag is the authority here as it is on the success path: a run is
        // canceled because a Cancel Event claimed it, never because the text of
        // whatever died happens to contain the word.
        const cancelled = cancelBoundary.hasLeftStartedBranch();
        const terminalStatus: TraversalTerminalStatus = cancelled
          ? "canceled"
          : "failed";

        // Same exactly-once treatment as the success path. A refusal here
        // escapes so the durable step can retry instead of being mistaken for
        // another traversal failure.
        const recorded = yield* recordRunFailure({
          run: input,
          runtime,
          store,
          entityEligibility,
          step: { id: "workflow-run-failed", name: "Run failed" },
          status: terminalStatus,
          failure,
        });

        return {
          status: recorded.status,
          success: recorded.status !== "failed",
          results: traversal.results,
          outputs: traversal.outputs,
          error: recorded.status === "failed" ? failure.message : undefined,
          cancelled: recorded.status === "canceled" || cancelled,
          exit: recorded.exit,
        };
      }

      // Wrapped as a durable step so the terminal record and its audit event are
      // written exactly once, even though the body replays after every wait. A
      // refusal escapes the traversal catch above and lets this step retry.
      const recorded = yield* runDurable(
        runtime,
        { id: "workflow-run-completed", name: "Run completed" },
        recordRunCompleted({
          store,
          executionId,
          workflowId,
          status: outcome.value.terminalStatus,
          output: outcome.value.finalOutput,
          failure: traversal.firstFailure(),
          resultCount: traversal.resultCount,
          runMode,
          exitContext: outcome.value.exitContext,
        })
      );

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
        status: recorded.status,
        success: recorded.status !== "failed",
        results: traversal.results,
        outputs: traversal.outputs,
        exit: recorded.exit,
      };
    });
  });
}

/**
 * Walks the branch below one Wait node, as a durable run of its own (ADR-0011).
 *
 * What it did travels back to the run that started the branch in the returned
 * value, and that run is where the Execution ends, where a cancellation routes,
 * and where a fatal error here is attributed, so this one lets an error escape.
 * A failed branch kill after this run claimed Exit is the exception: this run
 * writes the Execution's terminal record itself, because the run that started
 * it stays parked on any sibling the kill did not reach.
 */
export function executeWorkflowBranch(
  input: WorkflowBranchInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions,
  entities: WorkflowEntities = noWorkflowEntities
): Effect.Effect<BranchRunResult, EngineFailure> {
  const execute = executeWorkflowBranchInner(
    input,
    runtime,
    store,
    actions,
    entities
  ).pipe(
    Effect.annotateLogs(runLogAnnotations(input, runtime)),
    Effect.withSpan("wfgraph.workflow.branch", {
      attributes: {
        ...workflowSpanAttributes(input),
        "wfgraph.branch.entry_node_id": input.entryNodeId,
      },
    })
  );
  return withAppLogCategory(execute, "engine");
}

function executeWorkflowBranchInner(
  input: WorkflowBranchInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions,
  entities: WorkflowEntities
): Effect.Effect<BranchRunResult, EngineFailure> {
  return Effect.gen(function* () {
    const { entryNodeId, executionId } = input;
    const { nodes, traversal, scheduler, entityEligibility } = prepareRun(
      input,
      runtime,
      store,
      actions,
      entities
    );

    // Templates behind the Wait address the nodes above it, which this run never
    // walked. The store holds that view rather than the invoke payload, because an
    // HTTP Request step's response body is what makes those outputs large. The
    // cost is that a row whose close was refused leaves its template unresolved.
    const upstream = yield* runDurable(
      runtime,
      {
        id: `branch-upstream-${entryNodeId}`,
        name: "Inherit upstream outputs",
      },
      store.readNodeOutputs(executionId)
    );

    for (const node of nodes) {
      const data = upstream[node.id];
      if (node.id === entryNodeId || data === undefined) {
        continue;
      }
      traversal.inheritCompleted(node.id, {
        label: node.data.label || node.id,
        data: wrapStoredOutput(data),
      });
    }

    for (const nodeId of input.releasedNodeIds) {
      traversal.markReadyForDownstream(nodeId);
    }

    const branchStartTime = Date.now();
    yield* Effect.logInfo(`Branch started at ${entryNodeId}`).pipe(
      Effect.annotateLogs({
        ...runIdentity(input, runtime),
        branch: { entry: entryNodeId, inherited: Object.keys(upstream).length },
      })
    );

    yield* Effect.gen(function* () {
      yield* scheduler.runAll([entryNodeId]);
      // A wait further down this branch is handed off in turn, so this run holds
      // one pause of its own and the branch below that one holds its own.
      yield* scheduler.drainDeferredWaits();
    }).pipe(
      // A failed branch kill has already interrupted every node of this run,
      // and a sibling branch may still be parked. The run that started this
      // branch stays parked on that sibling, so this run ends the Execution.
      // The terminal record gives way to the Exit claim and reads exited. The
      // open rows are closed after it, because `loadPersistedRunInput` refuses
      // a sibling that wakes to a terminal row before it writes anything.
      Effect.catchTag("BranchStopFailed", (stopFailure) =>
        Effect.gen(function* () {
          yield* Effect.logError(
            "Branch kill failed; this branch run ends the Execution"
          ).pipe(Effect.annotateLogs({ error: stopFailure.message }));
          yield* recordRunFailure({
            run: input,
            runtime,
            store,
            entityEligibility,
            step: {
              id: `branch-exit-run-failed-${entryNodeId}`,
              name: "Run ended after a failed branch kill",
            },
            status: "failed",
            failure: engineFailure("failure", stopFailure.message),
          });
          yield* runDurableUnit(
            runtime,
            {
              id: `branch-exit-sweep-${entryNodeId}`,
              name: "Close open work",
            },
            store.cancelOpenWork({ executionId })
          );
        })
      )
    );

    // This branch resumed its own Wait and moved the Execution to "running". A
    // sibling branch may still be parked, and only a park writes "waiting", so
    // the run would read as executing with nothing executing until that sibling
    // woke. The repository write is guarded on the run still holding a waiting
    // wait row, so a branch that left nothing parked writes nothing. The run
    // that started this branch is the one that ends the Execution.
    yield* runDurableUnit(
      runtime,
      {
        id: `branch-park-check-${entryNodeId}`,
        name: "Re-park the run if a sibling wait is open",
      },
      Effect.asVoid(store.markExecutionWaitingIfParked({ executionId }))
    );

    const termination = yield* runDurable(
      runtime,
      {
        id: `branch-termination-${entryNodeId}`,
        name: "Read branch outcome",
      },
      store.readTerminationState(executionId)
    );
    const exit =
      termination?.claim?.kind === "exit"
        ? {
            reason: termination.claim.reason,
            nodeId: termination.claim.nodeId,
            checkedAt: termination.claim.requestedAt,
          }
        : undefined;

    yield* Effect.logInfo(
      `Branch at ${entryNodeId} ${exit ? "exited" : "completed"} in ${Date.now() - branchStartTime}ms`
    ).pipe(
      Effect.annotateLogs({
        branch: {
          entry: entryNodeId,
          nodes: traversal.resultCount,
          ms: Date.now() - branchStartTime,
        },
      })
    );

    return {
      results: { ...traversal.results },
      outputs: traversal.ownOutputs,
      ...(exit ? { exit } : {}),
    };
  });
}
