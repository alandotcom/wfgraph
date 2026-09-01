import { Effect } from "effect";
import { sql, type SQL } from "drizzle-orm";
import { generateId } from "@wfgraph/shared/utils/id";
import { toJsonObject } from "@wfgraph/shared/types/json";
import type {
  WaitResumeClaim,
  WaitsRepoMethods,
} from "#src/backend/services/executions/repo/waits";
import type { WorkflowWaitState } from "#src/backend/services/executions/repo";
import type {
  SqliteDatabase,
  SqliteExecutor,
} from "#src/backend/persistence/sqlite/database";
import {
  encodeJson,
  placeholders,
  requiredString,
  SQLITE_IN_FLIGHT_EXECUTION_STATUSES,
} from "#src/backend/persistence/sqlite/database";
import { sqliteWaitState } from "#src/backend/persistence/sqlite/executions/rows";

const WAIT_RESUME_CLAIM_LEASE_MS = 5 * 60 * 1000;
const IN_FLIGHT = sql.raw(SQLITE_IN_FLIGHT_EXECUTION_STATUSES);
type Row = Record<string, unknown>;

function claimWait(
  database: SqliteExecutor,
  column: "id" | "resume_token",
  value: string
): Effect.Effect<WaitResumeClaim | null, unknown> {
  return Effect.gen(function* () {
    const claimedAt = new Date();
    const claimedAtMs = claimedAt.getTime();
    const staleBefore = claimedAtMs - WAIT_RESUME_CLAIM_LEASE_MS;
    const candidate = yield* database.get<Row>(sql`
      select ws.id from workflow_wait_states ws
      join workflow_executions e on e.id = ws.execution_id
      where ws.${sql.identifier(column)} = ${value}
        and (ws.status = 'waiting'
          or (ws.status = 'resuming' and ws.resumed_at <= ${staleBefore}))
        and e.status in (${IN_FLIGHT})
    `);
    if (!candidate) return null;
    const candidateId = requiredString(candidate, "id");
    const claimed = yield* database.get<Row>(sql`
      update workflow_wait_states set status = 'resuming', resumed_at = ${claimedAtMs}
      where id = ${candidateId}
        and (status = 'waiting'
          or (status = 'resuming' and resumed_at <= ${staleBefore}))
      returning id
    `);
    if (!claimed) return null;
    const row = yield* database.get<Row>(sql`
      select * from workflow_wait_states where id = ${candidateId}
    `);
    if (!row) throw new Error("SQLite did not return the claimed wait");
    return { waitState: sqliteWaitState(row), claimedAt };
  });
}

export function makeSqliteWaitsMethods(
  store: SqliteDatabase
): WaitsRepoMethods {
  return {
    startWait: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const now = Date.now();
          const parked = yield* database.get<Row>(sql`
            update workflow_executions set status = 'waiting', waiting_at = ${now}
            where id = ${input.executionId} and status in (${IN_FLIGHT})
            returning id
          `);
          if (!parked) return undefined;
          const id = generateId();
          yield* database.run(sql`
            insert into workflow_wait_states (
              id, execution_id, workflow_id, run_id, node_id, node_name,
              wait_type, status, resume_token, wait_until,
              subscribed_events, metadata, created_at
            ) values (
              ${id}, ${input.executionId}, ${input.workflowId}, ${input.runId},
              ${input.nodeId}, ${input.nodeName}, ${input.waitType}, 'waiting',
              ${input.resumeToken ?? null}, ${input.waitUntil?.getTime() ?? null},
              ${JSON.stringify(input.subscribedEvents ?? [])},
              ${encodeJson(toJsonObject(input.metadata))}, ${now}
            )
          `);
          return { waitStateId: id };
        })
      ),
    markWaitStatus: (input) =>
      store.write((database) => {
        const allowed =
          input.status === "resumed"
            ? sql`status = 'waiting'`
            : sql`status in ('waiting', 'resuming')`;
        const now = Date.now();
        return database
          .get<Row>(sql`
            update workflow_wait_states set status = ${input.status},
              resumed_at = ${input.status === "cancelled" ? null : now},
              cancelled_at = ${input.status === "cancelled" ? now : null}
            where id = ${input.waitStateId} and ${allowed}
            returning id
          `)
          .pipe(Effect.map(Boolean));
      }),
    cancelWaits: (waitStateIds) =>
      store.write((database) => {
        if (waitStateIds.length === 0) return Effect.succeed<string[]>([]);
        return Effect.gen(function* () {
          const rows = yield* database.all<Row>(sql`
            select id from workflow_wait_states
            where id in (${placeholders(waitStateIds)})
              and status in ('waiting', 'resuming')
          `);
          yield* database.run(sql`
            update workflow_wait_states set status = 'cancelled',
              cancelled_at = ${Date.now()}
            where id in (${placeholders(waitStateIds)})
              and status in ('waiting', 'resuming')
          `);
          return rows.map((row) => requiredString(row, "id"));
        });
      }),
    cancelWaitsForExecution: (executionId) =>
      store.write((database) =>
        database.run(sql`
          update workflow_wait_states set status = 'cancelled',
            cancelled_at = ${Date.now()}
          where execution_id = ${executionId}
            and status in ('waiting', 'resuming')
        `)
      ),
    listWaitsForEvent: (input) =>
      store.read((database) => {
        const filters: SQL[] = [
          sql`ws.workflow_id = ${input.workflowId}`,
          sql`ws.status = 'waiting'`,
          sql`e.status in (${IN_FLIGHT})`,
          sql`exists (
            select 1 from json_each(ws.subscribed_events) j
            where j.value = ${input.eventName}
          )`,
        ];
        if (input.afterId) filters.push(sql`ws.id > ${input.afterId}`);
        if (input.excludingExecutionIds?.length) {
          filters.push(sql`
            ws.execution_id not in (${placeholders(input.excludingExecutionIds)})
          `);
        }
        return database
          .all<Row>(sql`
            select ws.* from workflow_wait_states ws
            join workflow_executions e on e.id = ws.execution_id
            where ${sql.join(filters, sql` and `)}
            order by ws.id asc limit ${input.limit}
          `)
          .pipe(Effect.map((rows) => rows.map(sqliteWaitState)));
      }),
    claimWaitingStateByToken: (resumeToken) =>
      store.write((database) =>
        claimWait(database, "resume_token", resumeToken)
      ),
    claimWaitingStateById: (waitStateId) =>
      store.write((database) => claimWait(database, "id", waitStateId)),
    settleWaitingStateClaim: (input) =>
      store.write((database) =>
        database
          .get<Row>(sql`
            update workflow_wait_states set status = 'resumed',
              resumed_at = ${Date.now()}
            where id = ${input.waitStateId} and status = 'resuming'
              and resumed_at = ${input.claimedAt.getTime()}
            returning id
          `)
          .pipe(Effect.map(Boolean))
      ),
    releaseWaitingStateClaim: (input) =>
      store.write((database) =>
        database
          .get<Row>(sql`
            update workflow_wait_states set status = 'waiting', resumed_at = null
            where id = ${input.waitStateId} and status = 'resuming'
              and resumed_at = ${input.claimedAt.getTime()}
            returning id
          `)
          .pipe(Effect.map(Boolean))
      ),
    listWaitingStates: (executionId) =>
      store.read((database) =>
        database
          .all<Row>(sql`
            select * from workflow_wait_states
            where execution_id = ${executionId} and status = 'waiting'
          `)
          .pipe(Effect.map((rows) => rows.map(sqliteWaitState)))
      ),
    listWaitingStatesForExecutions: (executionIds) =>
      store.read((database) => {
        if (executionIds.length === 0) {
          return Effect.succeed(new Map<string, WorkflowWaitState[]>());
        }
        return database
          .all<Row>(sql`
            select * from workflow_wait_states
            where execution_id in (${placeholders(executionIds)})
              and status = 'waiting'
          `)
          .pipe(
            Effect.map((rows) => {
              const grouped = new Map<string, WorkflowWaitState[]>();
              for (const raw of rows) {
                const row = sqliteWaitState(raw);
                const existing = grouped.get(row.executionId);
                if (existing) existing.push(row);
                else grouped.set(row.executionId, [row]);
              }
              return grouped;
            })
          );
      }),
  };
}
