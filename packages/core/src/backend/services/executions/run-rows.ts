import { Effect } from "effect";
import {
  AppLogger,
  type EffectLogger,
} from "#src/backend/lib/effect/app-logger";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import {
  InngestClient,
  type InngestError,
} from "#src/backend/lib/effect/inngest-client";
import type { RunScopedAuditEventType } from "#src/backend/services/executions/workflow-audit";
import { signalRunToStop } from "#src/backend/services/executions/end-runs";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { JsonObject, JsonObjectDraft } from "@rova/shared/types/json";
import type {
  WorkflowExecutionIgnoredReason,
  WorkflowExecutionStartSource,
} from "@rova/shared/lifecycle/execution-contracts";
import type {
  SerializedWorkflowGraph,
  WorkflowMode,
} from "@rova/shared/graph/types";

/** Identity of the workflow plus the published version the run will execute. */
export type WorkflowRunTarget = {
  id: string;
  name: string;
  graph: SerializedWorkflowGraph;
  versionId: string;
  catalogFingerprint: string;
};

/** Build the run target every start path hands to concurrency / enqueue. */
export function toWorkflowRunTarget(input: {
  workflow: { id: string; name: string };
  versionId: string;
  catalogFingerprint: string;
  graph: SerializedWorkflowGraph;
}): WorkflowRunTarget {
  return {
    id: input.workflow.id,
    name: input.workflow.name,
    graph: input.graph,
    versionId: input.versionId,
    catalogFingerprint: input.catalogFingerprint,
  };
}

/**
 * Where the run came from, and which entity it is about.
 *
 * `entityValue` is the string the Lifecycle Rules read out of the payload at the
 * Event's Correlation Path, or the workflow's own id for a start that carries no
 * payload. Runs sharing one are about the same entity.
 */
export type WorkflowRunStart = {
  source: WorkflowExecutionStartSource;
  eventName?: string;
  entityValue?: string;
  /**
   * The arrival this start answers, which for an Event is the id the bus carried
   * it under. It goes on the audit row so one arrival can be traced across every
   * workflow it started or was refused by.
   */
  deliveryId?: string;
};

export type EnqueueStartedRunInput = {
  workflow: WorkflowRunTarget;
  start: WorkflowRunStart;
  runMode: WorkflowMode;
  /** The row Concurrency opened, which this hands to the bus. */
  executionId: string;
  /**
   * The payload the entry node and downstream templates read from. It is JSON
   * because it arrived as JSON and is stored as JSON in the JSONB
   * `workflow_executions.input` column.
   */
  payload: JsonObject;
  /**
   * The untouched request body, kept alongside the payload so steps can reach
   * the raw shape. Entrypoints that never substitute a mock payload leave this
   * out and get the payload itself.
   */
  requestPayload?: JsonObject;
};

export type StartedWorkflowRun = {
  executionId: string;
  runId?: string;
  runMode: WorkflowMode;
};

export type RecordTerminalWorkflowRunInput = {
  workflowId: string;
  /** The published version this terminal row still pins. */
  workflowVersionId: string;
  start: WorkflowRunStart;
  runMode: WorkflowMode;
  payload: JsonObject;
  status: "completed" | "failed" | "canceled";
  error?: string;
  output?: JsonObject;
  audit: {
    // Run-scoped only: this path always inserts the terminal Execution the row
    // hangs off, and a refusal opens no run to hang one off at all.
    eventType: Extract<
      RunScopedAuditEventType,
      "run_cancelled" | "run_ignored" | "run_completed"
    >;
    message: string;
    metadata?: JsonObjectDraft;
  };
};

/** How each start source names itself in a "run started" timeline entry. */
const RUN_STARTED_LABELS: Record<WorkflowExecutionStartSource, string> = {
  manual: "Manual",
  schedule: "Scheduled",
  event: "Event-triggered",
};

/**
 * How each start source names the thing it declined to run, phrased so it reads
 * as a noun inside "Ignored <subject> because ...".
 */
const IGNORED_SUBJECTS: Record<WorkflowExecutionStartSource, string> = {
  manual: "manual run",
  schedule: "scheduled run",
  event: "event",
};

export function buildRunStartedAuditMessage(input: {
  startSource: WorkflowExecutionStartSource;
  runMode: WorkflowMode;
  eventName?: string;
}): string {
  const label = RUN_STARTED_LABELS[input.startSource];
  const mode = input.runMode === "test" ? " test mode" : "";
  const event = input.eventName ? ` for ${input.eventName}` : "";
  return `${label}${mode} run started${event}`;
}

/**
 * The sentence a Refused Start is recorded with, and the one a paused workflow's
 * ignored run gets. Both open with the same three words as the panel's heading, so
 * a builder reading a row knows which list it belongs to.
 */
export function buildIgnoredRunAuditMessage(input: {
  startSource: WorkflowExecutionStartSource;
  reason: WorkflowExecutionIgnoredReason;
  eventName?: string;
}): string {
  const subject = IGNORED_SUBJECTS[input.startSource];

  if (input.reason === "workflow_paused") {
    return `Ignored ${subject} because workflow is paused`;
  }

  const named = input.eventName ? `${subject} ${input.eventName}` : subject;

  if (input.reason === "concurrency_first_wins") {
    return `Refused a start from ${named}: a run for this entity is already going and Concurrency is first-wins`;
  }

  if (input.reason === "entity_value_missing") {
    return `Refused a start from ${named}: nothing at this workflow's Correlation Path, and Concurrency needs an entity to compare`;
  }

  if (input.reason === "start_event_required") {
    return `Refused a start from ${named}: this workflow splits on the Event a run is on, and this start named none`;
  }

  return `Refused a start from ${named}: this workflow does not list manual runs as a start source`;
}

/** This module's logger, as the Effect that produces it (see `services/workflows/workflow.ts`). */
const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "run-rows").with({ workflowId })
  );

/**
 * Tells the bus about a run whose row already exists, and records the timeline
 * entry.
 *
 * The row is opened by `ExecutionRepo.startForEntity`, under the lock that makes
 * Concurrency a decision rather than a race, and the send stays out here because
 * a transaction has no business waiting on Inngest.
 *
 * The send is the only step here that may fail the caller, and the ordering says
 * why. Before it, nothing irreversible has happened, so a compensation can close
 * the row. After it the run exists and this call is bookkeeping, so a refused
 * write is logged and the run is reported as started: failing would put the
 * caller's Inngest step into a retry that enqueues nothing new and re-runs
 * everything around it.
 */
export const enqueueStartedRun = Effect.fn("enqueueStartedRun")(function* (
  input: EnqueueStartedRunInput
) {
  const repo = yield* ExecutionRepo;
  const inngest = yield* InngestClient;
  const { workflow, start, runMode, payload } = input;
  const logger = yield* loggerFor(workflow.id);
  const execution = { id: input.executionId };

  const run = yield* inngest
    .sendRunRequested({
      graph: workflow.graph,
      workflowVersionId: workflow.versionId,
      catalogFingerprint: workflow.catalogFingerprint,
      startPayload: payload,
      ...(start.eventName ? { startEventName: start.eventName } : {}),
      requestPayload: input.requestPayload ?? payload,
      executionId: execution.id,
      workflowId: workflow.id,
      workflowName: workflow.name,
      runMode,
    })
    .pipe(Effect.tapError((failure) => closeRefusedEnqueue(input, failure)));

  yield* bookkeeping(
    logger,
    "record that the bus took the run",
    execution.id,
    repo.markEnqueued({
      executionId: execution.id,
      runId: run.eventId ?? null,
    })
  );

  yield* bookkeeping(
    logger,
    "write the run's opening timeline entry",
    execution.id,
    repo.recordAuditEvent({
      workflowId: workflow.id,
      executionId: execution.id,
      eventType: "run_started",
      message: buildRunStartedAuditMessage({
        startSource: start.source,
        runMode,
        eventName: start.eventName,
      }),
      metadata: {
        startSource: start.source,
        runMode,
        eventName: start.eventName,
        entityValue: start.entityValue,
        deliveryId: start.deliveryId,
        runId: run.eventId,
      },
    })
  );

  const started: StartedWorkflowRun = {
    executionId: execution.id,
    runId: run.eventId,
    runMode,
  };
  return started;
});

/**
 * Runs a write whose side effect has already landed, so a refusal is a log line.
 *
 * The same policy `runWithStepLog` states for a node's closing log row: once the
 * irreversible thing is done, a bookkeeping failure may not cause it to be done
 * again.
 */
const bookkeeping = <A>(
  logger: EffectLogger,
  what: string,
  executionId: string,
  write: Effect.Effect<A, DatabaseError>
) =>
  write.pipe(
    Effect.catchTag("DatabaseError", (error) =>
      logger.error(`The run is enqueued, but the database refused to ${what}`, {
        executionId,
        error,
      })
    )
  );

/**
 * Undoes a start whose send was refused: the run is told to stop, then its row
 * is closed.
 *
 * The order is what makes the close safe. A refused send is ambiguous -- Inngest
 * may have taken the event and failed on the way back, in which case the run is
 * already executing -- and the row's in-flight guard cannot tell those apart,
 * since a run that started a moment ago is `running` like one that never
 * started. The cancel resolves it: an accepted run is stopped, and a signal for a
 * run that does not exist is a no-op at Inngest. A cancel that itself fails to
 * send leaves the row closed anyway and says so on the timeline, which is the
 * same half-failure `cancelInFlightRuns` reports.
 */
const closeRefusedEnqueue = Effect.fn("closeRefusedEnqueue")(function* (
  input: EnqueueStartedRunInput,
  failure: InngestError
) {
  const repo = yield* ExecutionRepo;
  const logger = yield* loggerFor(input.workflow.id);
  const error =
    failure.cause instanceof Error
      ? failure.cause.message
      : "Failed to enqueue run";

  yield* signalRunToStop({
    workflowId: input.workflow.id,
    executionId: input.executionId,
    reason: error,
    eventName: input.start.eventName,
  });

  const closed = yield* repo.markEnqueueFailed({
    executionId: input.executionId,
    error,
  });

  if (!closed) {
    // The run reached a verdict of its own, which the compensation is not
    // allowed to overwrite.
    yield* logger.info(
      "Enqueue reported failure but the run had already left the in-flight statuses",
      { executionId: input.executionId }
    );
  }
});

/**
 * Writes an execution row for a request that reached a verdict without ever
 * running the graph, such as a cancellation or an ignored event. The row starts
 * and completes at the same instant so the run list still shows the decision.
 *
 * A caller owes a row whenever the runs list is the only feedback it gives: the
 * manual execute route answers a screen whose next question is "what happened",
 * and a decision with no row reads there as nothing having happened at all.
 */
export const recordTerminalWorkflowRun = Effect.fn("recordTerminalWorkflowRun")(
  function* (input: RecordTerminalWorkflowRunInput) {
    const repo = yield* ExecutionRepo;

    const execution = yield* repo.insertTerminal({
      workflowId: input.workflowId,
      workflowVersionId: input.workflowVersionId,
      status: input.status,
      startSource: input.start.source,
      runMode: input.runMode,
      startEventName: input.start.eventName,
      entityValue: input.start.entityValue,
      input: input.payload,
      output: input.output,
      error: input.error,
    });

    yield* repo.recordAuditEvent({
      workflowId: input.workflowId,
      executionId: execution.id,
      eventType: input.audit.eventType,
      message: input.audit.message,
      metadata: input.audit.metadata,
    });

    return execution;
  }
);

/**
 * The terminal row a paused workflow's request gets.
 *
 * The manual route is the only caller: a paused workflow is filtered out of the
 * subscription join, so an Event never reaches one. The row exists because the
 * runs list is the only
 * feedback the Run button gives, and a decision with no row reads there as nothing
 * having happened.
 */
export const recordPausedRunIgnored = Effect.fn("recordPausedRunIgnored")(
  function* (input: {
    workflowId: string;
    workflowVersionId: string;
    startSource: WorkflowExecutionStartSource;
    runMode: WorkflowMode;
    payload: JsonObject;
  }) {
    return yield* recordTerminalWorkflowRun({
      workflowId: input.workflowId,
      workflowVersionId: input.workflowVersionId,
      start: { source: input.startSource },
      runMode: input.runMode,
      payload: input.payload,
      status: "completed",
      output: {
        status: "ignored",
        reason: "workflow_paused",
        runMode: input.runMode,
      },
      audit: {
        eventType: "run_ignored",
        message: buildIgnoredRunAuditMessage({
          startSource: input.startSource,
          reason: "workflow_paused",
        }),
        metadata: {
          reason: "workflow_paused",
          runMode: input.runMode,
        },
      },
    });
  }
);
