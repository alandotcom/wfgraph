import { Effect } from "effect";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  isEntityEligibilityReason,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type {
  EntityStartOutcome,
  ExecutionRepo,
  NewExecution,
  StartForEntityInput,
} from "#src/backend/services/executions/repo";
import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteReadExecutor,
} from "#src/backend/persistence/sqlite/database";
import { encodeJson } from "#src/backend/persistence/sqlite/database";
import {
  workflowExecutionEvents,
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/persistence/sqlite/schema";
import {
  makeSqliteRunsMethods,
  insertExecution,
} from "#src/backend/persistence/sqlite/executions/runs";
import { makeSqliteNodeLogsMethods } from "#src/backend/persistence/sqlite/executions/logs";
import { makeSqliteWaitsMethods } from "#src/backend/persistence/sqlite/executions/waits";
import {
  makeSqliteAuditMethods,
  recordAuditEventWrite,
} from "#src/backend/persistence/sqlite/executions/audit";
import { makeSqliteFencedWrites } from "#src/backend/persistence/sqlite/executions/fenced-writes";
import { makeSqliteClaimsMethods } from "#src/backend/persistence/sqlite/executions/claims";
import { makeSqliteInboxMethods } from "#src/backend/persistence/sqlite/executions/inbox";
import {
  endExecutions,
  insertRunSchedule,
  makeSqlitePassWrites,
  makeSqliteScheduleMethods,
} from "#src/backend/persistence/sqlite/executions/schedule";
import {
  optionalJsonObject,
  sqliteExecution,
} from "#src/backend/persistence/sqlite/executions/rows";

function findAdmissionRefusal(
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

function supersedeInFlightExecutions(
  database: SqliteExecutor,
  ids: string[],
  supersededReason: string
) {
  if (ids.length === 0) return Effect.succeed<string[]>([]);
  return endExecutions(
    database,
    database
      .update(workflowExecutions)
      .set({
        status: "superseded",
        waitingAt: null,
        completedAt: Date.now(),
        error: supersededReason,
      })
      .where(
        and(
          inArray(workflowExecutions.id, ids),
          inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
          isNull(workflowExecutions.terminationKind)
        )
      )
      .returning({ id: workflowExecutions.id })
      .pipe(
        Effect.map((rows) => {
          const ended = rows.map((row) => row.id);
          return { result: ended, ended };
        })
      )
  );
}

/**
 * Inserts the run's execution row, its schedule row due at `input.now`, and
 * its "run started" entry, in the caller's write transaction.
 */
function openRun(database: SqliteExecutor, input: StartForEntityInput) {
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

function startForEntity(
  database: SqliteExecutor,
  input: StartForEntityInput
): Effect.Effect<EntityStartOutcome, unknown> {
  const { execution, concurrency, admissionDecisionId } = input;
  return Effect.gen(function* () {
    if (admissionDecisionId) {
      const refusal = yield* findAdmissionRefusal(database, {
        workflowId: execution.workflowId,
        decisionId: admissionDecisionId,
      });
      if (refusal) {
        return { status: "admission_refused" as const, reason: refusal };
      }
    }

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
      input.supersededReason
    );
    if (supersededExecutionIds.length > 0) {
      yield* database
        .update(workflowWaitStates)
        .set({ status: "cancelled", cancelledAt: Date.now() })
        .where(
          and(
            inArray(workflowWaitStates.executionId, supersededExecutionIds),
            eq(workflowWaitStates.status, "waiting")
          )
        );
    }

    return {
      status: "started" as const,
      execution: yield* openRun(database, input),
      supersededExecutionIds,
    };
  });
}

export function makeSqliteExecutionRepo(
  store: SqliteDatabase
): ExecutionRepo["Service"] {
  return {
    ...makeSqliteRunsMethods(store),
    ...makeSqliteNodeLogsMethods(store),
    ...makeSqliteWaitsMethods(store),
    ...makeSqliteAuditMethods(store),
    ...makeSqliteScheduleMethods(store),
    ...makeSqliteClaimsMethods(store),
    ...makeSqliteInboxMethods(store),
    fenced: makeSqliteFencedWrites(store),
    fencedDelivery: (fence) => makeSqlitePassWrites(store, fence),
    startForEntity: (input) =>
      store.write((database) => startForEntity(database, input)),
    findAdmissionRefusal: (input) =>
      store.read((database) => findAdmissionRefusal(database, input)),
    recordAdmissionRefusal: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const existingExecution = yield* database
            .select({ id: workflowExecutions.id })
            .from(workflowExecutions)
            .where(
              and(
                eq(workflowExecutions.workflowId, input.workflowId),
                eq(workflowExecutions.deliveryId, input.deliveryId)
              )
            )
            .get();
          if (existingExecution) {
            return {
              kind: "started" as const,
              executionId: existingExecution.id,
            };
          }

          const existingRefusal = yield* findAdmissionRefusal(database, {
            workflowId: input.workflowId,
            decisionId: input.decisionId,
          });
          if (existingRefusal) {
            return { kind: "refused" as const, reason: existingRefusal };
          }

          yield* database.insert(workflowExecutionEvents).values({
            id: input.decisionId,
            workflowId: input.workflowId,
            executionId: null,
            eventType: "run_refused",
            message: input.message,
            metadata: encodeJson(input.metadata),
            createdAt: Date.now(),
          });
          return { kind: "refused" as const, reason: input.reason };
        })
      ),
    deleteAllForWorkflow: (workflowId) =>
      store.write((database) =>
        Effect.gen(function* () {
          yield* database
            .delete(workflowExecutionEvents)
            .where(eq(workflowExecutionEvents.workflowId, workflowId));
          const rows = yield* database
            .delete(workflowExecutions)
            .where(eq(workflowExecutions.workflowId, workflowId))
            .returning({ id: workflowExecutions.id });
          return rows.length;
        })
      ),
  };
}
