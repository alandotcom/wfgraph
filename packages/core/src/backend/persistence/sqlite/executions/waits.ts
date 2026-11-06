import { Effect } from "effect";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { generateId } from "@wfgraph/shared/utils/id";
import { readJsonObject, toJsonObject } from "@wfgraph/shared/types/json";
import {
  claimKindAdmits,
  IN_FLIGHT_EXECUTION_STATUSES,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  claimAdmits,
  notExitClaimed,
} from "#src/backend/persistence/sqlite/executions/runs";
import type { WaitArrival } from "@wfgraph/shared/lifecycle/wait-signal";
import {
  arrivalOfWake,
  type ReparkWaitOutcome,
  type ReparkWaitRefusal,
  resumeWakeOf,
  type WaitResumeClaim,
  type WaitsRepoMethods,
} from "#src/backend/services/executions/repo/waits";
import { wakeExecutions } from "#src/backend/persistence/sqlite/executions/schedule";
import type {
  OwnerFence,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo";
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
  optionalJsonValue,
  sqliteParkState,
  sqliteParkWake,
  sqliteWaitState,
} from "#src/backend/persistence/sqlite/executions/rows";

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
 * Whether an Event or a manual resume may claim this row, as the PostgreSQL
 * backend's `claimableWait` decides: one still `waiting`, or one whose pending
 * wake is a Migration's `migrate` wake, which the Event replaces.
 */
function claimableWait(): SQL {
  return sql`(${workflowWaitStates.status} = 'waiting' or (${workflowWaitStates.status} = 'resuming' and json_extract(${workflowWaitStates.wake}, '$.kind') = 'migrate'))`;
}

/**
 * Whether this delivery's own claim already resolved the row, as the PostgreSQL
 * backend's `claimedByDelivery` decides: `resuming` with a `resume` wake naming
 * `deliveryId`.
 */
function claimedByDelivery(deliveryId: string): SQL {
  return sql`(${workflowWaitStates.status} = 'resuming' and json_extract(${workflowWaitStates.wake}, '$.kind') = 'resume' and json_extract(${workflowWaitStates.wake}, '$.deliveryId') = ${deliveryId})`;
}

/**
 * Claims one row for an Event or a manual resume through `wakeExecutions`, as
 * the PostgreSQL backend's `claimWaitState` does: the `resume` wake and
 * `resuming`, then the run made due. A row whose `resume` wake the arrival's
 * own delivery already wrote answers as claimed, unwritten and not re-queued.
 */
function claimWait(
  database: SqliteExecutor,
  input: {
    identity: SQL | undefined;
    arrival: WaitArrival;
    now: Date;
  }
): Effect.Effect<WaitResumeClaim | null, unknown> {
  const { identity, arrival, now } = input;
  const claim = Effect.gen(function* () {
    const unclaimed = { result: null, woken: [] };
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
          claimableWait(),
          inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
          notExitClaimed
        )
      )
      .get();
    if (!candidate) {
      if (arrival.deliveryId === undefined) return unclaimed;
      const ownClaim = yield* database
        .select()
        .from(workflowWaitStates)
        .where(and(identity, claimedByDelivery(arrival.deliveryId)))
        .get();
      return {
        result: ownClaim ? sqliteWaitState(ownClaim) : null,
        woken: [],
      };
    }
    const [claimed] = yield* database
      .update(workflowWaitStates)
      .set({
        status: "resuming",
        resumedAt: now.getTime(),
        wake: encodeJson(resumeWakeOf(arrival)),
      })
      .where(
        and(eq(workflowWaitStates.id, candidate.id), identity, claimableWait())
      )
      .returning();
    if (!claimed) return unclaimed;
    const waitState = sqliteWaitState(claimed);
    return { result: waitState, woken: [waitState.executionId] };
  });
  return Effect.map(wakeExecutions(database, now, claim), ({ result, due }) =>
    result === null ? null : { waitState: result, requeued: due.length > 0 }
  );
}

type StartWaitInput = Parameters<WaitsRepoMethods["startWait"]>[0];
type ReparkWaitInput = Parameters<WaitsRepoMethods["reparkWait"]>[0];
type MarkWaitStatusInput = Parameters<WaitsRepoMethods["markWaitStatus"]>[0];

/**
 * Narrows a fenced write to the wait rows of the Execution its pass runs, so a
 * fenced write addressed by wait row id cannot reach another run's row.
 */
function ofFencedExecution(fence: OwnerFence | undefined): SQL | undefined {
  return fence === undefined
    ? undefined
    : eq(workflowWaitStates.executionId, fence.executionId);
}

/** The park behind `startWait`, inside the caller's write transaction. */
export function startWaitWrite(input: StartWaitInput) {
  return (database: SqliteExecutor) =>
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
            eq(workflowExecutions.workflowVersionId, input.workflowVersionId),
            inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
            claimAdmits(input.side)
          )
        )
        .returning({ id: workflowExecutions.id });
      if (!parked) return undefined;
      const [existing] = yield* database
        .select()
        .from(workflowWaitStates)
        .where(
          and(
            eq(workflowWaitStates.executionId, input.executionId),
            eq(workflowWaitStates.nodeId, input.nodeId)
          )
        )
        .limit(1);
      if (existing) {
        if (existing.status === "waiting") {
          yield* database
            .update(workflowWaitStates)
            .set({
              waitType: input.waitType,
              resumeToken: input.resumeToken ?? null,
              waitUntil: input.waitUntil?.getTime() ?? null,
              subscribedEvents: JSON.stringify(input.subscribedEvents ?? []),
              metadata: encodeJson({
                ...optionalJsonObject(existing.metadata, "wait metadata"),
                ...toJsonObject(input.metadata),
              }),
            })
            .where(eq(workflowWaitStates.id, existing.id));
        }
        return { waitStateId: existing.id };
      }
      const id = generateId();
      yield* database.insert(workflowWaitStates).values({
        id,
        executionId: input.executionId,
        workflowId: input.workflowId,
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
    });
}

/**
 * Whether a re-park may write over this row, as the PostgreSQL backend's
 * `reparkableWait` decides: still `waiting`, or resolved by the database
 * executor with a `migrate` or `timeout` wake the re-park supersedes.
 */
function isReparkable(row: { status: string; wake: string | null }): boolean {
  if (row.status === "waiting") return true;
  if (row.status !== "resuming") return false;
  const kind = readJsonObject(optionalJsonValue(row.wake, "wake"))?.kind;
  return kind === "migrate" || kind === "timeout";
}

/**
 * The re-park behind `reparkWait`. Given a fence, it reaches only a wait row of
 * the fenced Execution. The row goes back to `waiting` with no wake and no park
 * step, so the next `waitForEvent` parks on it afresh.
 */
export function reparkWaitWrite(input: ReparkWaitInput, fence?: OwnerFence) {
  return (database: SqliteExecutor) =>
    Effect.gen(function* () {
      // The read and the write share one `BEGIN IMMEDIATE`, so the status and
      // the pinned version this reads are the ones the write sees.
      const [row] = yield* database
        .select({
          status: workflowWaitStates.status,
          wake: workflowWaitStates.wake,
          pinnedVersionId: workflowExecutions.workflowVersionId,
          terminationKind: workflowExecutions.terminationKind,
          metadata: workflowWaitStates.metadata,
        })
        .from(workflowWaitStates)
        .leftJoin(
          workflowExecutions,
          eq(workflowExecutions.id, workflowWaitStates.executionId)
        )
        .where(
          and(
            eq(workflowWaitStates.id, input.waitStateId),
            ofFencedExecution(fence)
          )
        )
        .limit(1);

      if (!row || !isReparkable(row)) {
        return refusedRepark("not_waiting");
      }
      if (row.pinnedVersionId !== input.workflowVersionId) {
        return refusedRepark("version_moved");
      }
      if (!claimKindAdmits(row.terminationKind, input.side)) {
        return refusedRepark("not_waiting");
      }

      yield* database
        .update(workflowWaitStates)
        .set({
          waitType: input.waitType,
          waitUntil: input.waitUntil?.getTime() ?? null,
          subscribedEvents: JSON.stringify(input.subscribedEvents),
          resumeToken: input.resumeToken,
          metadata: encodeJson({
            ...optionalJsonObject(row.metadata, "wait metadata"),
            ...input.metadata,
          }),
          status: "waiting",
          wake: null,
          parkStepId: null,
        })
        .where(eq(workflowWaitStates.id, input.waitStateId));

      const reparked: ReparkWaitOutcome = { ok: true };
      return reparked;
    });
}

/**
 * The settle behind `markWaitStatus`. Given a fence, it reaches only a wait
 * row of the fenced Execution.
 */
export function markWaitStatusWrite(
  input: MarkWaitStatusInput,
  fence?: OwnerFence
) {
  return (database: SqliteExecutor) => {
    const now = Date.now();
    return database
      .update(workflowWaitStates)
      .set({
        status: input.status,
        resumedAt: input.status === "cancelled" ? null : now,
        cancelledAt: input.status === "cancelled" ? now : null,
      })
      .where(
        and(
          eq(workflowWaitStates.id, input.waitStateId),
          ofFencedExecution(fence),
          inArray(workflowWaitStates.status, ["waiting", "resuming"])
        )
      )
      .returning({ id: workflowWaitStates.id })
      .pipe(Effect.map((rows) => rows.length > 0));
  };
}

/**
 * The transition behind `settleWaitTimeout`. Given a fence, it reaches only a
 * wait row of the fenced Execution.
 */
export function settleWaitTimeoutWrite(
  waitStateId: string,
  fence?: OwnerFence
) {
  return (database: SqliteExecutor) =>
    Effect.gen(function* () {
      const [row] = yield* database
        .select({
          status: workflowWaitStates.status,
          wake: workflowWaitStates.wake,
        })
        .from(workflowWaitStates)
        .where(
          and(eq(workflowWaitStates.id, waitStateId), ofFencedExecution(fence))
        )
        .limit(1);

      if (!row) return null;

      const arrival = arrivalOfWake(sqliteParkWake(row.wake));
      if (row.status === "resumed") return arrival;
      if (row.status !== "waiting" && row.status !== "resuming") return null;

      const settled = yield* database
        .update(workflowWaitStates)
        .set({
          status: arrival ? "resumed" : "timed_out",
          resumedAt: Date.now(),
        })
        .where(
          and(
            eq(workflowWaitStates.id, waitStateId),
            eq(workflowWaitStates.status, row.status)
          )
        )
        .returning({ id: workflowWaitStates.id });

      return settled.length > 0 ? arrival : null;
    });
}

export function makeSqliteWaitsMethods(
  store: SqliteDatabase
): WaitsRepoMethods {
  return {
    startWait: (input) => store.write(startWaitWrite(input)),
    reparkWait: (input) => store.write(reparkWaitWrite(input)),
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
    findPark: (waitStateId) =>
      store.read((database) =>
        database
          .select({
            waitStateId: workflowWaitStates.id,
            executionId: workflowWaitStates.executionId,
            status: workflowWaitStates.status,
            parkStepId: workflowWaitStates.parkStepId,
            wake: workflowWaitStates.wake,
          })
          .from(workflowWaitStates)
          .where(eq(workflowWaitStates.id, waitStateId))
          .limit(1)
          .pipe(
            Effect.map((rows) => {
              const [row] = rows;
              return row ? sqliteParkState(row) : null;
            })
          )
      ),
    markWaitStatus: (input) => store.write(markWaitStatusWrite(input)),
    settleWaitTimeout: (waitStateId) =>
      store.write(settleWaitTimeoutWrite(waitStateId)),
    listWaitsForEvent: (input) =>
      store.read((database) => {
        const filters: SQL[] = [
          eq(workflowWaitStates.workflowId, input.workflowId),
          eq(workflowWaitStates.status, "waiting"),
          inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
          notExitClaimed,
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
        claimWait(database, {
          identity: and(
            eq(workflowWaitStates.resumeToken, input.resumeToken),
            eq(workflowWaitStates.waitType, "event")
          ),
          arrival: input.arrival,
          now: input.now,
        })
      ),
    claimWaitingStateById: (input) =>
      store.write((database) =>
        claimWait(database, {
          identity: and(
            eq(workflowWaitStates.id, input.waitStateId),
            eq(workflowWaitStates.waitType, "event"),
            input.resumeToken === null
              ? isNull(workflowWaitStates.resumeToken)
              : eq(workflowWaitStates.resumeToken, input.resumeToken),
            subscribedTo(input.eventName)
          ),
          arrival: input.arrival,
          now: input.now,
        })
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
    listOpenWaitNodeIds: (executionId) =>
      store.read((database) =>
        database
          .selectDistinct({ nodeId: workflowWaitStates.nodeId })
          .from(workflowWaitStates)
          .where(
            and(
              eq(workflowWaitStates.executionId, executionId),
              eq(workflowWaitStates.status, "waiting")
            )
          )
          .pipe(Effect.map((rows) => rows.map((row) => row.nodeId)))
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
