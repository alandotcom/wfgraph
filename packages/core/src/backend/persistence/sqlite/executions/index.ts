import { Effect } from "effect";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { partition } from "es-toolkit/array";
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  type EntityEligibilityReason,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type { Concurrency } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type {
  EntityStartOutcome,
  NewExecution,
} from "#src/backend/services/executions/repo";
import {
  ExecutionRepo,
  UNSENT_RUN_GRACE_MS,
  UNSENT_RUN_RECLAIM_REASON,
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
import { makeSqliteAuditMethods } from "#src/backend/persistence/sqlite/executions/audit";
import {
  optionalJsonObject,
  sqliteExecution,
} from "#src/backend/persistence/sqlite/executions/rows";

function entityEligibilityReason(
  value: unknown
): EntityEligibilityReason | null {
  return value === "entity_condition_not_met" || value === "entity_not_found"
    ? value
    : null;
}

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
      Effect.map((row) =>
        entityEligibilityReason(
          row ? optionalJsonObject(row.metadata, "metadata")?.reason : undefined
        )
      )
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

function endInFlightExecutions(
  database: SqliteExecutor,
  ids: string[],
  update: { status: "failed" | "superseded"; error: string }
) {
  if (ids.length === 0) return Effect.succeed<string[]>([]);
  const inFlight = and(
    inArray(workflowExecutions.id, ids),
    inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
    isNull(workflowExecutions.terminationKind)
  );
  return Effect.gen(function* () {
    const rows = yield* database
      .select({ id: workflowExecutions.id })
      .from(workflowExecutions)
      .where(inFlight);
    const eligible = rows.map((row) => row.id);
    if (eligible.length === 0) return [];
    yield* database
      .update(workflowExecutions)
      .set({
        status: update.status,
        waitingAt: null,
        completedAt: Date.now(),
        error: update.error,
      })
      .where(
        and(
          inArray(workflowExecutions.id, eligible),
          inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
          isNull(workflowExecutions.terminationKind)
        )
      );
    return eligible;
  });
}

function startForEntity(
  database: SqliteExecutor,
  execution: NewExecution,
  concurrency: Concurrency,
  supersededReason: string,
  admissionDecisionId?: string
): Effect.Effect<EntityStartOutcome, unknown> {
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

    const own = yield* findByDelivery(database, execution);
    if (own) {
      return {
        status: "started" as const,
        execution: own,
        supersededExecutionIds: [],
        reclaimedExecutionIds: [],
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
        execution: yield* insertExecution(database, execution, "running"),
        supersededExecutionIds: [],
        reclaimedExecutionIds: [],
      };
    }

    const inFlight = yield* database
      .select({
        id: workflowExecutions.id,
        enqueuedAt: workflowExecutions.enqueuedAt,
        startedAt: workflowExecutions.startedAt,
      })
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

    let reclaimedExecutionIds: string[] = [];
    if (inFlight.length > 0 && concurrency === "first-wins") {
      const staleBefore = Date.now() - UNSENT_RUN_GRACE_MS;
      const [stuck, live] = partition(
        inFlight,
        (candidate) =>
          candidate.enqueuedAt === null && candidate.startedAt < staleBefore
      );
      if (live.length > 0) {
        return {
          status: "refused" as const,
          inFlightExecutionIds: live.map((candidate) => candidate.id),
        };
      }
      reclaimedExecutionIds = yield* endInFlightExecutions(
        database,
        stuck.map((candidate) => candidate.id),
        { status: "failed", error: UNSENT_RUN_RECLAIM_REASON }
      );
    }

    let supersededExecutionIds: string[] = [];
    if (inFlight.length > 0 && concurrency !== "first-wins") {
      supersededExecutionIds = yield* endInFlightExecutions(
        database,
        inFlight.map((row) => row.id),
        { status: "superseded", error: supersededReason }
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
    }

    return {
      status: "started" as const,
      execution: yield* insertExecution(database, execution, "running"),
      supersededExecutionIds,
      reclaimedExecutionIds,
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
    startForEntity: ({
      execution,
      concurrency,
      supersededReason,
      admissionDecisionId,
    }) =>
      store.write((database) =>
        startForEntity(
          database,
          execution,
          concurrency,
          supersededReason,
          admissionDecisionId
        )
      ),
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
