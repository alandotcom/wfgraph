import { Effect } from "effect";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { generateId } from "@wfgraph/shared/utils/id";
import { toJsonObject } from "@wfgraph/shared/types/json";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import type {
  WaitResumeClaim,
  WaitsRepoMethods,
} from "#src/backend/services/executions/repo/waits";
import type { WorkflowWaitState } from "#src/backend/services/executions/repo";
import type {
  SqliteDatabase,
  SqliteExecutor,
} from "#src/backend/persistence/sqlite/database";
import { encodeJson } from "#src/backend/persistence/sqlite/database";
import {
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/persistence/sqlite/schema";
import { sqliteWaitState } from "#src/backend/persistence/sqlite/executions/rows";

const WAIT_RESUME_CLAIM_LEASE_MS = 5 * 60 * 1000;

const waitStateSelection = {
  id: workflowWaitStates.id,
  executionId: workflowWaitStates.executionId,
  workflowId: workflowWaitStates.workflowId,
  runId: workflowWaitStates.runId,
  nodeId: workflowWaitStates.nodeId,
  nodeName: workflowWaitStates.nodeName,
  waitType: workflowWaitStates.waitType,
  status: workflowWaitStates.status,
  resumeToken: workflowWaitStates.resumeToken,
  waitUntil: workflowWaitStates.waitUntil,
  subscribedEvents: workflowWaitStates.subscribedEvents,
  metadata: workflowWaitStates.metadata,
  createdAt: workflowWaitStates.createdAt,
  resumedAt: workflowWaitStates.resumedAt,
  cancelledAt: workflowWaitStates.cancelledAt,
};

function claimWait(
  database: SqliteExecutor,
  column: "id" | "resume_token",
  value: string
): Effect.Effect<WaitResumeClaim | null, unknown> {
  return Effect.gen(function* () {
    const claimedAt = new Date();
    const claimedAtMs = claimedAt.getTime();
    const staleBefore = claimedAtMs - WAIT_RESUME_CLAIM_LEASE_MS;
    const identity =
      column === "id"
        ? eq(workflowWaitStates.id, value)
        : eq(workflowWaitStates.resumeToken, value);
    const claimable = or(
      eq(workflowWaitStates.status, "waiting"),
      and(
        eq(workflowWaitStates.status, "resuming"),
        lte(workflowWaitStates.resumedAt, staleBefore)
      )
    );
    const candidate = yield* database
      .select({ id: workflowWaitStates.id })
      .from(workflowWaitStates)
      .innerJoin(
        workflowExecutions,
        eq(workflowExecutions.id, workflowWaitStates.executionId)
      )
      .where(
        and(
          identity,
          claimable,
          inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES)
        )
      )
      .get();
    if (!candidate) return null;
    const [claimed] = yield* database
      .update(workflowWaitStates)
      .set({ status: "resuming", resumedAt: claimedAtMs })
      .where(and(eq(workflowWaitStates.id, candidate.id), claimable))
      .returning();
    if (!claimed) return null;
    return { waitState: sqliteWaitState(claimed), claimedAt };
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
          const [parked] = yield* database
            .update(workflowExecutions)
            .set({ status: "waiting", waitingAt: now })
            .where(
              and(
                eq(workflowExecutions.id, input.executionId),
                inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES)
              )
            )
            .returning({ id: workflowExecutions.id });
          if (!parked) return undefined;
          const id = generateId();
          yield* database.insert(workflowWaitStates).values({
            id,
            executionId: input.executionId,
            workflowId: input.workflowId,
            runId: input.runId,
            nodeId: input.nodeId,
            nodeName: input.nodeName,
            waitType: input.waitType,
            status: "waiting",
            resumeToken: input.resumeToken ?? null,
            waitUntil: input.waitUntil?.getTime() ?? null,
            subscribedEvents: JSON.stringify(input.subscribedEvents ?? []),
            metadata: encodeJson(toJsonObject(input.metadata)),
            createdAt: now,
          });
          return { waitStateId: id };
        })
      ),
    markWaitStatus: (input) =>
      store.write((database) => {
        const allowed =
          input.status === "resumed"
            ? eq(workflowWaitStates.status, "waiting")
            : inArray(workflowWaitStates.status, ["waiting", "resuming"]);
        const now = Date.now();
        return database
          .update(workflowWaitStates)
          .set({
            status: input.status,
            resumedAt: input.status === "cancelled" ? null : now,
            cancelledAt: input.status === "cancelled" ? now : null,
          })
          .where(and(eq(workflowWaitStates.id, input.waitStateId), allowed))
          .returning({ id: workflowWaitStates.id })
          .pipe(Effect.map((rows) => rows.length > 0));
      }),
    cancelWaits: (waitStateIds) =>
      store.write((database) => {
        if (waitStateIds.length === 0) return Effect.succeed<string[]>([]);
        const cancellable = and(
          inArray(workflowWaitStates.id, waitStateIds),
          inArray(workflowWaitStates.status, ["waiting", "resuming"])
        );
        return Effect.gen(function* () {
          const rows = yield* database
            .select({ id: workflowWaitStates.id })
            .from(workflowWaitStates)
            .where(cancellable);
          yield* database
            .update(workflowWaitStates)
            .set({ status: "cancelled", cancelledAt: Date.now() })
            .where(cancellable);
          return rows.map((row) => row.id);
        });
      }),
    cancelWaitsForExecution: (executionId) =>
      store.write((database) =>
        database
          .update(workflowWaitStates)
          .set({ status: "cancelled", cancelledAt: Date.now() })
          .where(
            and(
              eq(workflowWaitStates.executionId, executionId),
              inArray(workflowWaitStates.status, ["waiting", "resuming"])
            )
          )
      ),
    listWaitsForEvent: (input) =>
      store.read((database) => {
        const filters: SQL[] = [
          eq(workflowWaitStates.workflowId, input.workflowId),
          eq(workflowWaitStates.status, "waiting"),
          inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
          sql`exists (
            select 1 from json_each(${workflowWaitStates.subscribedEvents}) j
            where j.value = ${input.eventName}
          )`,
        ];
        if (input.afterId) {
          filters.push(gt(workflowWaitStates.id, input.afterId));
        }
        if (input.excludingExecutionIds?.length) {
          filters.push(
            notInArray(
              workflowWaitStates.executionId,
              input.excludingExecutionIds
            )
          );
        }
        return database
          .select(waitStateSelection)
          .from(workflowWaitStates)
          .innerJoin(
            workflowExecutions,
            eq(workflowExecutions.id, workflowWaitStates.executionId)
          )
          .where(and(...filters))
          .orderBy(asc(workflowWaitStates.id))
          .limit(input.limit)
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
          .update(workflowWaitStates)
          .set({ status: "resumed", resumedAt: Date.now() })
          .where(
            and(
              eq(workflowWaitStates.id, input.waitStateId),
              eq(workflowWaitStates.status, "resuming"),
              eq(workflowWaitStates.resumedAt, input.claimedAt.getTime())
            )
          )
          .returning({ id: workflowWaitStates.id })
          .pipe(Effect.map((rows) => rows.length > 0))
      ),
    releaseWaitingStateClaim: (input) =>
      store.write((database) =>
        database
          .update(workflowWaitStates)
          .set({ status: "waiting", resumedAt: null })
          .where(
            and(
              eq(workflowWaitStates.id, input.waitStateId),
              eq(workflowWaitStates.status, "resuming"),
              eq(workflowWaitStates.resumedAt, input.claimedAt.getTime())
            )
          )
          .returning({ id: workflowWaitStates.id })
          .pipe(Effect.map((rows) => rows.length > 0))
      ),
    listWaitingStates: (executionId) =>
      store.read((database) =>
        database
          .select()
          .from(workflowWaitStates)
          .where(
            and(
              eq(workflowWaitStates.executionId, executionId),
              eq(workflowWaitStates.status, "waiting")
            )
          )
          .pipe(Effect.map((rows) => rows.map(sqliteWaitState)))
      ),
    listWaitingStatesForExecutions: (executionIds) =>
      store.read((database) => {
        if (executionIds.length === 0) {
          return Effect.succeed(new Map<string, WorkflowWaitState[]>());
        }
        return database
          .select()
          .from(workflowWaitStates)
          .where(
            and(
              inArray(workflowWaitStates.executionId, executionIds),
              eq(workflowWaitStates.status, "waiting")
            )
          )
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
