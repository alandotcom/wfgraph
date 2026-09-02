import { Effect } from "effect";
import { and, eq, inArray } from "drizzle-orm";
import { partition } from "es-toolkit/array";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
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
} from "#src/backend/persistence/sqlite/database";
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
import { sqliteExecution } from "#src/backend/persistence/sqlite/executions/rows";

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
    inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES)
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
          inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES)
        )
      );
    return eligible;
  });
}

function startForEntity(
  database: SqliteExecutor,
  execution: NewExecution,
  concurrency: Concurrency,
  supersededReason: string
): Effect.Effect<EntityStartOutcome, unknown> {
  return Effect.gen(function* () {
    const own = yield* findByDelivery(database, execution);
    if (own) {
      return {
        status: "started" as const,
        execution: own,
        supersededExecutionIds: [],
        reclaimedExecutionIds: [],
      };
    }
    if (concurrency === "unlimited" || !execution.entityValue) {
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
          eq(workflowExecutions.entityValue, execution.entityValue),
          eq(workflowExecutions.runMode, execution.runMode),
          inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES)
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
    startForEntity: ({ execution, concurrency, supersededReason }) =>
      store.write((database) =>
        startForEntity(database, execution, concurrency, supersededReason)
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
