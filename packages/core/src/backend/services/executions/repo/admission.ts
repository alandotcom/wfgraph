/**
 * The admission of a new run on PostgreSQL: Concurrency applied to the entity
 * the run is about, and the run opened with its schedule row and its "run
 * started" entry. Each function runs inside a transaction the caller owns:
 * `startForEntity` opens one of its own, and a cron fire runs
 * `admitWithConcurrency` in the transaction fenced on its timer's lease.
 */

import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { workflowExecutions } from "#src/backend/lib/db/schema";
import type {
  WfGraphDatabase,
  WfGraphTransaction,
} from "#src/backend/lib/db/index";
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  isEntityEligibilityReason,
  type EntityEligibilityReason,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import { recordAuditEventWrite } from "#src/backend/services/executions/repo/audit";
import { endRunsWrite } from "#src/backend/services/executions/repo/runs";
import { insertRunSchedule } from "#src/backend/services/executions/repo/schedule";
import type {
  ConcurrencyStartOutcome,
  EntityStartOutcome,
  NewExecution,
  StartForEntityInput,
  WorkflowExecution,
} from "#src/backend/services/executions/repo/contracts";

export async function findAdmissionRefusal(
  database: WfGraphDatabase | WfGraphTransaction,
  input: { workflowId: string; decisionId: string }
): Promise<EntityEligibilityReason | null> {
  const row = await database.query.workflowExecutionEvents.findFirst({
    where: {
      id: input.decisionId,
      workflowId: input.workflowId,
      eventType: "run_refused",
    },
    columns: { metadata: true },
  });
  const reason = row?.metadata?.reason;
  return isEntityEligibilityReason(reason) ? reason : null;
}

/**
 * A start's answer once it holds a row. An insert that conflicted on the
 * delivery constraint always finds the row its delivery committed, so a
 * missing row is a defect.
 */
function started(
  row: WorkflowExecution | undefined,
  supersededExecutionIds: string[]
): ConcurrencyStartOutcome {
  if (!row) {
    throw new Error(
      "A start found neither a new row nor the row its delivery committed"
    );
  }
  return { status: "started", execution: row, supersededExecutionIds };
}

/**
 * The runs Concurrency compares a new run against: those about the same
 * entity, by its typed identity when it has one and by the legacy
 * `entityValue` otherwise. Undefined for a run with neither, which no
 * Concurrency compares.
 */
export function entityPredicate(execution: NewExecution): SQL | undefined {
  if (execution.entityType !== undefined && execution.entityId !== undefined) {
    return and(
      eq(workflowExecutions.entityType, execution.entityType),
      eq(workflowExecutions.entityId, execution.entityId)
    );
  }
  return execution.entityValue === undefined
    ? undefined
    : eq(workflowExecutions.entityValue, execution.entityValue);
}

async function findByDelivery(
  tx: WfGraphTransaction,
  execution: NewExecution
): Promise<WorkflowExecution | undefined> {
  if (!execution.deliveryId) {
    return undefined;
  }
  return await tx.query.workflowExecutions.findFirst({
    where: {
      workflowId: execution.workflowId,
      deliveryId: execution.deliveryId,
    },
  });
}

/**
 * Inserts the run's execution row, its schedule row due at `input.now`, and
 * its "run started" entry. A row this arrival already opened is answered in
 * its place, whatever status it is in: the run may have finished while the
 * step was being retried, and opening a second one would run the graph twice
 * for one Event.
 */
export async function openRun(
  tx: WfGraphTransaction,
  input: Pick<StartForEntityInput, "execution" | "startedEntry" | "now">
): Promise<ConcurrencyStartOutcome> {
  const { execution } = input;
  const [row] = await tx
    .insert(workflowExecutions)
    .values({
      workflowId: execution.workflowId,
      workflowVersionId: execution.workflowVersionId,
      status: "running",
      startSource: execution.startSource,
      runMode: execution.runMode,
      startEventName: execution.startEventName,
      entityValue: execution.entityValue,
      entityType: execution.entityType,
      entityId: execution.entityId,
      deliveryId: execution.deliveryId,
      scheduledFor: execution.scheduled?.slot,
      scheduleCron: execution.scheduled?.schedule.cron,
      scheduleTimeZone: execution.scheduled?.schedule.timeZone,
      input: execution.input,
    })
    .onConflictDoNothing({
      target: [workflowExecutions.workflowId, workflowExecutions.deliveryId],
    })
    .returning();

  // The conflict fires when two attempts at one arrival reach here together.
  // `unlimited` has no entity decision to serialize, so the delivery
  // constraint is its idempotency boundary. The attempt that inserted the row
  // also wrote its schedule row and entry.
  if (!row) {
    return started(await findByDelivery(tx, execution), []);
  }

  await insertRunSchedule(tx, { executionId: row.id, wakeAt: input.now });
  await recordAuditEventWrite({
    workflowId: execution.workflowId,
    executionId: row.id,
    eventType: "run_started",
    message: input.startedEntry.message,
    metadata: input.startedEntry.metadata,
  })(tx);
  return started(row, []);
}

/**
 * Whether admitting this start reads other rows before it writes, which needs
 * a serializable transaction: an Entity admission decision to consult, or a
 * Concurrency that compares the run's entity.
 */
export function admissionReads(input: StartForEntityInput): boolean {
  return (
    input.admissionDecisionId !== undefined ||
    (input.concurrency !== "unlimited" &&
      entityPredicate(input.execution) !== undefined)
  );
}

/**
 * Decides a start and opens its run, in the caller's transaction, which is
 * serializable whenever `admissionReads` says so: two starts reading an empty
 * in-flight set must not both open a run.
 *
 * An Entity admission refusal recorded for this delivery answers first, and
 * `admitWithConcurrency` decides the rest.
 */
export async function admitStart(
  tx: WfGraphTransaction,
  input: StartForEntityInput
): Promise<EntityStartOutcome> {
  const { admissionDecisionId, ...start } = input;
  if (admissionDecisionId) {
    const refusal = await findAdmissionRefusal(tx, {
      workflowId: start.execution.workflowId,
      decisionId: admissionDecisionId,
    });
    if (refusal) {
      return { status: "admission_refused", reason: refusal };
    }
  }
  return await admitWithConcurrency(tx, start);
}

/**
 * Decides a start that consults no Entity admission decision and opens its
 * run, in the caller's transaction, as `admitStart` describes. The delivery's
 * own row answers first. First-wins refuses a start while a run for the
 * entity is in flight, and newest-wins ends those runs `superseded`, writing
 * each one's `run_superseded` entry and settling its schedule and wait rows,
 * before it opens the new one.
 */
export async function admitWithConcurrency(
  tx: WfGraphTransaction,
  input: Omit<StartForEntityInput, "admissionDecisionId">
): Promise<ConcurrencyStartOutcome> {
  const { execution, concurrency } = input;
  // Asked before Concurrency is, because this arrival's own row is not a run
  // to defer to or displace. It is this call's answer.
  const own = await findByDelivery(tx, execution);
  if (own) {
    return started(own, []);
  }

  const entity = entityPredicate(execution);
  if (concurrency === "unlimited" || !entity) {
    return await openRun(tx, input);
  }

  const inFlight = await tx
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.workflowId, execution.workflowId),
        entity,
        eq(workflowExecutions.runMode, execution.runMode),
        inArray(workflowExecutions.status, [...IN_FLIGHT_EXECUTION_STATUSES]),
        isNull(workflowExecutions.terminationKind)
      )
    );
  const ids = inFlight.map((row) => row.id);

  if (ids.length > 0 && concurrency === "first-wins") {
    return { status: "refused", inFlightExecutionIds: ids };
  }

  // Newest-wins only. First-wins deferred to the runs it found above, and
  // displaces nothing.
  const superseded = await endRunsWrite(tx, {
    executionIds: ids,
    ending: { kind: "supersede", startEventName: execution.startEventName },
  });
  const supersededExecutionIds = superseded
    .filter(({ answer }) => answer.kind === "ended")
    .map((run) => run.executionId);

  const opened = await openRun(tx, input);
  return opened.status === "started"
    ? { ...opened, supersededExecutionIds }
    : opened;
}
