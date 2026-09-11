import { Effect } from "effect";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { generateId } from "@wfgraph/shared/utils/id";
import { toJsonObject } from "@wfgraph/shared/types/json";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  WAIT_ARRIVAL_METADATA_KEY,
  type WaitArrival,
} from "@wfgraph/shared/lifecycle/wait-signal";
import type {
  ReparkWaitOutcome,
  ReparkWaitRefusal,
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
import {
  optionalJsonObject,
  sqliteWaitState,
} from "#src/backend/persistence/sqlite/executions/rows";

const WAIT_RESUME_CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Whether a wait row's `subscribed_events` still lists this Event name. The
 * column holds a JSON array, so the test walks it with `json_each`.
 */
function subscribedTo(eventName: string): SQL {
  return sql`exists (
    select 1 from json_each(${workflowWaitStates.subscribedEvents}) j
    where j.value = ${eventName}
  )`;
}

/** A re-park the row's status or the run's pinned version refused. */
function refusedRepark(reason: ReparkWaitRefusal): ReparkWaitOutcome {
  return { ok: false, reason };
}

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

/**
 * Claims one row and records the wake on it, so a run between two parks can
 * read back the signal it was not listening for.
 */
function claimWait(
  database: SqliteExecutor,
  identity: SQL | undefined,
  arrival: WaitArrival
): Effect.Effect<WaitResumeClaim | null, unknown> {
  return Effect.gen(function* () {
    const claimedAt = new Date();
    const claimedAtMs = claimedAt.getTime();
    const staleBefore = claimedAtMs - WAIT_RESUME_CLAIM_LEASE_MS;
    const claimable = or(
      eq(workflowWaitStates.status, "waiting"),
      and(
        eq(workflowWaitStates.status, "resuming"),
        lte(workflowWaitStates.resumedAt, staleBefore)
      )
    );
    const candidate = yield* database
      .select({
        id: workflowWaitStates.id,
        metadata: workflowWaitStates.metadata,
      })
      .from(workflowWaitStates)
      .innerJoin(
        workflowExecutions,
        eq(workflowExecutions.id, workflowWaitStates.executionId)
      )
      .where(
        and(
          identity,
          claimable,
          inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
          isNull(workflowExecutions.terminationKind)
        )
      )
      .get();
    if (!candidate) return null;
    const [claimed] = yield* database
      .update(workflowWaitStates)
      .set({
        status: "resuming",
        resumedAt: claimedAtMs,
        metadata: encodeJson({
          ...optionalJsonObject(candidate.metadata, "metadata"),
          [WAIT_ARRIVAL_METADATA_KEY]: { ...arrival },
        }),
      })
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
          // The version predicate is this park's fence. The statement writes the
          // execution row itself, so the pin is compared on that row rather than
          // through the correlated subquery `reparkWait` needs.
          const [parked] = yield* database
            .update(workflowExecutions)
            .set({ status: "waiting", waitingAt: now })
            .where(
              and(
                eq(workflowExecutions.id, input.executionId),
                eq(
                  workflowExecutions.workflowVersionId,
                  input.workflowVersionId
                ),
                inArray(
                  workflowExecutions.status,
                  IN_FLIGHT_EXECUTION_STATUSES
                ),
                isNull(workflowExecutions.terminationKind)
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
    reparkWait: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          // The read and the write share one `BEGIN IMMEDIATE`, so the status
          // and the pinned version this reads are the ones the write sees.
          const [row] = yield* database
            .select({
              status: workflowWaitStates.status,
              pinnedVersionId: workflowExecutions.workflowVersionId,
              terminationKind: workflowExecutions.terminationKind,
            })
            .from(workflowWaitStates)
            .leftJoin(
              workflowExecutions,
              eq(workflowExecutions.id, workflowWaitStates.executionId)
            )
            .where(eq(workflowWaitStates.id, input.waitStateId))
            .limit(1);

          if (row?.status !== "waiting") {
            return refusedRepark("not_waiting");
          }
          if (row.pinnedVersionId !== input.workflowVersionId) {
            return refusedRepark("version_moved");
          }
          if (row.terminationKind !== null) {
            return refusedRepark("not_waiting");
          }

          yield* database
            .update(workflowWaitStates)
            .set({
              waitType: input.waitType,
              waitUntil: input.waitUntil?.getTime() ?? null,
              subscribedEvents: JSON.stringify(input.subscribedEvents),
              resumeToken: input.resumeToken,
              metadata: encodeJson(input.metadata),
            })
            .where(eq(workflowWaitStates.id, input.waitStateId));

          const reparked: ReparkWaitOutcome = { ok: true };
          return reparked;
        })
      ),
    findWaitStateById: (waitStateId) =>
      store.read((database) =>
        database
          .select()
          .from(workflowWaitStates)
          .where(eq(workflowWaitStates.id, waitStateId))
          .limit(1)
          .pipe(
            Effect.map((rows) => {
              const [row] = rows;
              return row ? sqliteWaitState(row) : null;
            })
          )
      ),
    markWaitStatus: (input) =>
      store.write((database) => {
        const allowed = inArray(workflowWaitStates.status, [
          "waiting",
          "resuming",
        ]);
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
          isNull(workflowExecutions.terminationKind),
          subscribedTo(input.eventName),
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
    claimWaitingStateByToken: (input) =>
      store.write((database) =>
        claimWait(
          database,
          and(
            eq(workflowWaitStates.resumeToken, input.resumeToken),
            eq(workflowWaitStates.waitType, "event")
          ),
          input.arrival
        )
      ),
    claimWaitingStateById: (input) =>
      store.write((database) =>
        claimWait(
          database,
          and(
            eq(workflowWaitStates.id, input.waitStateId),
            eq(workflowWaitStates.waitType, "event"),
            subscribedTo(input.eventName)
          ),
          input.arrival
        )
      ),
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
    listActiveWaitStates: (executionId) =>
      store.read((database) =>
        database
          .select()
          .from(workflowWaitStates)
          .where(
            and(
              eq(workflowWaitStates.executionId, executionId),
              inArray(workflowWaitStates.status, ["waiting", "resuming"])
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
