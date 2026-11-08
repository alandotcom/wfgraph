/**
 * The admission of a new run on SQLite, as the PostgreSQL backend's
 * `repo/admission.ts` describes it. Each function runs inside the caller's
 * write transaction, which holds the one writer, so the in-flight read and the
 * insert are one decision: `startForEntity` opens a transaction of its own, and
 * a cron fire runs `admitWithConcurrency` in the one fenced on its timer.
 */

import { Effect } from "effect";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  isEntityEligibilityReason,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type {
  ConcurrencyStartOutcome,
  EntityStartOutcome,
  NewExecution,
  StartForEntityInput,
} from "#src/backend/services/executions/repo";
import type {
  SqliteExecutor,
  SqliteReadExecutor,
} from "#src/backend/persistence/sqlite/database";
import {
  workflowExecutionEvents,
  workflowExecutions,
} from "#src/backend/persistence/sqlite/schema";
import {
  endedRunColumns,
  insertExecution,
} from "#src/backend/persistence/sqlite/executions/runs";
import {
  recordAuditEventsWrite,
  recordAuditEventWrite,
} from "#src/backend/persistence/sqlite/executions/audit";
import {
  endExecutions,
  insertRunSchedule,
} from "#src/backend/persistence/sqlite/executions/schedule";
import {
  optionalJsonObject,
  sqliteExecution,
} from "#src/backend/persistence/sqlite/executions/rows";

export function findAdmissionRefusal(
  database: SqliteReadExecutor,
  input: { workflowId: string; decisionId: string }
) {
  return database
    .select({ metadata: workflowExecutionEvents.metadata })
    .from(workflowExecutionEvents)
    .where(
      and(
        eq(workflowExecutionEvents.id, input.decisionId),
        eq(workflowExecutionEvents.workflowId, input.workflowId),
        eq(workflowExecutionEvents.eventType, "run_refused")
      )
    )
    .get()
    .pipe(
      Effect.map((row) => {
        const reason = row
          ? optionalJsonObject(row.metadata, "metadata")?.reason
          : undefined;
        return isEntityEligibilityReason(reason) ? reason : null;
      })
    );
}

function findByDelivery(database: SqliteExecutor, execution: NewExecution) {
  if (!execution.deliveryId) return Effect.succeed(null);
  return database
    .select()
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.workflowId, execution.workflowId),
        eq(workflowExecutions.deliveryId, execution.deliveryId)
      )
    )
    .get()
    .pipe(Effect.map((row) => (row ? sqliteExecution(row) : null)));
}

/**
 * Ends the runs `ids` names that are still in flight and unclaimed as
 * `superseded`, each with its `run_superseded` entry, and answers their ids.
 */
function supersedeInFlightExecutions(
  database: SqliteExecutor,
  ids: string[],
  input: Pick<StartForEntityInput, "execution" | "supersededReason">
) {
  if (ids.length === 0) return Effect.succeed<string[]>([]);
  return endExecutions(
    database,
    Effect.gen(function* () {
      const rows = yield* database
        .update(workflowExecutions)
        .set({
          ...endedRunColumns("superseded"),
          error: input.supersededReason,
        })
        .where(
          and(
            inArray(workflowExecutions.id, ids),
            inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
            isNull(workflowExecutions.terminationKind)
          )
        )
        .returning({ id: workflowExecutions.id });
      const ended = rows.map((row) => row.id);
      yield* recordAuditEventsWrite(
        ended.map((executionId) => ({
          workflowId: input.execution.workflowId,
          executionId,
          eventType: "run_superseded",
          message: input.supersededReason,
          metadata: { eventName: input.execution.startEventName },
        }))
      )(database);
      return { result: ended, ended };
    })
  );
}

/**
 * Inserts the run's execution row, its schedule row due at `input.now`, and
 * its "run started" entry, in the caller's write transaction.
 */
function openRun(
  database: SqliteExecutor,
  input: Pick<StartForEntityInput, "execution" | "startedEntry" | "now">
) {
  return Effect.gen(function* () {
    const execution = yield* insertExecution(
      database,
      input.execution,
      "running"
    );
    yield* insertRunSchedule(database, {
      executionId: execution.id,
      wakeAt: input.now,
    });
    yield* recordAuditEventWrite({
      workflowId: execution.workflowId,
      executionId: execution.id,
      eventType: "run_started",
      message: input.startedEntry.message,
      metadata: input.startedEntry.metadata,
    })(database);
    return execution;
  });
}

/**
 * Decides a start and opens its run in the caller's write transaction. An
 * Entity admission refusal recorded for this delivery answers first, and
 * `admitWithConcurrency` decides the rest.
 */
export function admitStart(
  database: SqliteExecutor,
  input: StartForEntityInput
): Effect.Effect<EntityStartOutcome, unknown> {
  const { admissionDecisionId, ...start } = input;
  return Effect.gen(function* () {
    if (admissionDecisionId) {
      const refusal = yield* findAdmissionRefusal(database, {
        workflowId: start.execution.workflowId,
        decisionId: admissionDecisionId,
      });
      if (refusal) {
        return { status: "admission_refused" as const, reason: refusal };
      }
    }
    return yield* admitWithConcurrency(database, start);
  });
}

/**
 * Decides a start that consults no Entity admission decision and opens its
 * run in the caller's write transaction. The delivery's own row answers
 * first. First-wins refuses a start while a run for the entity is in flight,
 * and newest-wins ends those runs `superseded`, writing each one's
 * `run_superseded` entry and settling its schedule and wait rows, before it
 * opens the new one.
 */
export function admitWithConcurrency(
  database: SqliteExecutor,
  input: Omit<StartForEntityInput, "admissionDecisionId">
): Effect.Effect<ConcurrencyStartOutcome, unknown> {
  const { execution, concurrency } = input;
  return Effect.gen(function* () {
    // Whatever status the arrival's own row is in, it is the answer: the run
    // may have finished while the step was being retried, and opening a
    // second one would run the graph twice for one Event.
    const own = yield* findByDelivery(database, execution);
    if (own) {
      return {
        status: "started" as const,
        execution: own,
        supersededExecutionIds: [],
      };
    }
    const entityPredicate =
      execution.entityType !== undefined && execution.entityId !== undefined
        ? and(
            eq(workflowExecutions.entityType, execution.entityType),
            eq(workflowExecutions.entityId, execution.entityId)
          )
        : execution.entityValue === undefined
          ? undefined
          : eq(workflowExecutions.entityValue, execution.entityValue);
    if (concurrency === "unlimited" || !entityPredicate) {
      return {
        status: "started" as const,
        execution: yield* openRun(database, input),
        supersededExecutionIds: [],
      };
    }

    const inFlight = yield* database
      .select({ id: workflowExecutions.id })
      .from(workflowExecutions)
      .where(
        and(
          eq(workflowExecutions.workflowId, execution.workflowId),
          entityPredicate,
          eq(workflowExecutions.runMode, execution.runMode),
          inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
          isNull(workflowExecutions.terminationKind)
        )
      );

    if (inFlight.length > 0 && concurrency === "first-wins") {
      return {
        status: "refused" as const,
        inFlightExecutionIds: inFlight.map((candidate) => candidate.id),
      };
    }

    const supersededExecutionIds = yield* supersedeInFlightExecutions(
      database,
      inFlight.map((row) => row.id),
      input
    );

    return {
      status: "started" as const,
      execution: yield* openRun(database, input),
      supersededExecutionIds,
    };
  });
}
