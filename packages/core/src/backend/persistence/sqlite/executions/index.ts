import { Effect } from "effect";
import { sql } from "drizzle-orm";
import { partition } from "es-toolkit";
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
  placeholders,
  requiredNumber,
  requiredString,
  SQLITE_IN_FLIGHT_EXECUTION_STATUSES,
} from "#src/backend/persistence/sqlite/database";
import {
  makeSqliteRunsMethods,
  insertExecution,
} from "#src/backend/persistence/sqlite/executions/runs";
import { makeSqliteNodeLogsMethods } from "#src/backend/persistence/sqlite/executions/logs";
import { makeSqliteWaitsMethods } from "#src/backend/persistence/sqlite/executions/waits";
import { makeSqliteAuditMethods } from "#src/backend/persistence/sqlite/executions/audit";
import { sqliteExecution } from "#src/backend/persistence/sqlite/executions/rows";

const IN_FLIGHT = sql.raw(SQLITE_IN_FLIGHT_EXECUTION_STATUSES);
type Row = Record<string, unknown>;

function findByDelivery(database: SqliteExecutor, execution: NewExecution) {
  if (!execution.deliveryId) return Effect.succeed(null);
  return database
    .get<Row>(sql`
      select * from workflow_executions
      where workflow_id = ${execution.workflowId}
        and delivery_id = ${execution.deliveryId}
    `)
    .pipe(Effect.map((row) => (row ? sqliteExecution(row) : null)));
}

function endInFlightExecutions(
  database: SqliteExecutor,
  ids: string[],
  update: { status: "failed" | "superseded"; error: string }
) {
  if (ids.length === 0) return Effect.succeed<string[]>([]);
  return Effect.gen(function* () {
    const rows = yield* database.all<Row>(sql`
      select id from workflow_executions
      where id in (${placeholders(ids)}) and status in (${IN_FLIGHT})
    `);
    const eligible = rows.map((row) => requiredString(row, "id"));
    if (eligible.length === 0) return [];
    yield* database.run(sql`
      update workflow_executions set status = ${update.status}, waiting_at = null,
        completed_at = ${Date.now()}, error = ${update.error}
      where id in (${placeholders(eligible)}) and status in (${IN_FLIGHT})
    `);
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

    const inFlight = yield* database.all<Row>(sql`
      select id, enqueued_at, started_at from workflow_executions
      where workflow_id = ${execution.workflowId}
        and entity_value = ${execution.entityValue}
        and run_mode = ${execution.runMode}
        and status in (${IN_FLIGHT})
    `);

    let reclaimedExecutionIds: string[] = [];
    if (inFlight.length > 0 && concurrency === "first-wins") {
      const staleBefore = Date.now() - UNSENT_RUN_GRACE_MS;
      const candidates = inFlight.map((row) => ({
        id: requiredString(row, "id"),
        enqueuedAt: row.enqueued_at,
        startedAt: requiredNumber(row, "started_at"),
      }));
      const [stuck, live] = partition(
        candidates,
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
        inFlight.map((row) => requiredString(row, "id")),
        { status: "superseded", error: supersededReason }
      );
      if (supersededExecutionIds.length > 0) {
        yield* database.run(sql`
          update workflow_wait_states set status = 'cancelled',
            cancelled_at = ${Date.now()}
          where execution_id in (${placeholders(supersededExecutionIds)})
            and status = 'waiting'
        `);
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
          yield* database.run(sql`
            delete from workflow_execution_events where workflow_id = ${workflowId}
          `);
          const rows = yield* database.all<Row>(sql`
            delete from workflow_executions where workflow_id = ${workflowId}
            returning id
          `);
          return rows.length;
        })
      ),
  };
}
