/**
 * The arrival-order rule between a Cancel Event and a start, decided once for
 * both backends: a Cancel claims a run whose start Event was received no later
 * than the Cancel Event, and never a run whose start Event was received after
 * it, whichever of the two deliveries runs first. A run no Event started, or
 * whose start's inbox row is gone, has no arrival to compare and is claimed
 * as any in-flight run is.
 *
 * The Cancel side filters the runs it claims (`startedNoLaterThan`). The start
 * side looks, once its run is open, for a Cancel decision of its workflow and
 * Entity received no earlier than its own arrival (`cancelReceivedNoEarlier`),
 * and claims the run for that Cancel. Each backend runs the statements inside
 * its own transaction; PostgreSQL serializes the two sides on the Entity with
 * `cancelScopeLockKeys`, and SQLite's one writer serializes them already.
 */

import { type Column, type SQL, sql, type Table } from "drizzle-orm";
import {
  type BoundInstant,
  instantOf,
} from "#src/backend/services/executions/repo/release-policy";
import type { ExecutionEntitySelector } from "#src/backend/services/executions/repo/contracts";

/** The inbox columns the rule reads an arrival's instant from. */
type ArrivalInbox = { table: Table; id: Column; receivedAt: Column };

/** A run's identity, in whichever forms it carries. */
type RunEntity = {
  entityType?: string | null | undefined;
  entityId?: string | null | undefined;
  entityValue?: string | null | undefined;
};

/**
 * Whether a Cancel Event received at `cancelReceivedAt` may claim this run by
 * arrival order: no inbox row names the run's delivery with a later arrival.
 */
export function startedNoLaterThan(
  run: { deliveryId: Column },
  inbox: ArrivalInbox,
  cancelReceivedAt: BoundInstant
): SQL {
  return sql`not exists (select 1 from ${inbox.table} where ${inbox.id} = ${run.deliveryId} and ${inbox.receivedAt} > ${instantOf(inbox.receivedAt, cancelReceivedAt)})`;
}

/** The decision row columns a start's lookup reads. */
type DecisionColumns = {
  workflowId: Column;
  eventName: Column;
  entityType: Column;
  entityId: Column;
  entityValue: Column;
  receivedAt: Column;
};

/**
 * The identity form a run is matched in: its typed Entity when it carries
 * one, and its legacy Entity Value otherwise, as Concurrency compares it.
 * Undefined for a run that names no Entity, which no Cancel reaches.
 */
function ownForm(
  run: RunEntity
):
  | { kind: "typed"; entityType: string; entityId: string }
  | { kind: "value"; entityValue: string }
  | undefined {
  if (
    run.entityType !== undefined &&
    run.entityType !== null &&
    run.entityId !== undefined &&
    run.entityId !== null
  ) {
    return {
      kind: "typed",
      entityType: run.entityType,
      entityId: run.entityId,
    };
  }
  return run.entityValue === undefined || run.entityValue === null
    ? undefined
    : { kind: "value", entityValue: run.entityValue };
}

/**
 * Whether this Cancel decision claims a run opened just now in `workflowId`
 * for `run`'s Entity, whose start Event was received at `startReceivedAt`:
 * the decision names that Entity in the run's own form and was received no
 * earlier than the start. Undefined for a run that names no Entity.
 */
export function cancelReceivedNoEarlier(
  decisions: DecisionColumns,
  input: { workflowId: string; run: RunEntity; startReceivedAt: BoundInstant }
): SQL | undefined {
  const form = ownForm(input.run);
  if (form === undefined) return undefined;
  const entity =
    form.kind === "typed"
      ? sql`${decisions.entityType} = ${form.entityType} and ${decisions.entityId} = ${form.entityId}`
      : sql`${decisions.entityValue} = ${form.entityValue}`;
  return sql`(${decisions.workflowId} = ${input.workflowId} and ${entity} and ${decisions.eventName} is not null and ${decisions.receivedAt} >= ${instantOf(decisions.receivedAt, input.startReceivedAt)})`;
}

/** The lock key of one identity form of an Entity in one workflow. */
function lockKey(
  workflowId: string,
  form: NonNullable<ReturnType<typeof ownForm>>
): string {
  return form.kind === "typed"
    ? JSON.stringify([workflowId, "typed", form.entityType, form.entityId])
    : JSON.stringify([workflowId, "value", form.entityValue]);
}

/**
 * The advisory lock keys a Cancel claim and an Event start take before either
 * reads, so the start's decision lookup and the Cancel's run scan cannot both
 * miss each other. A Cancel takes one key per identity form it names, sorted,
 * and a start the key of its own form, which one of the Cancel's keys equals
 * whenever the two concern the same Entity.
 */
export function cancelScopeLockKeys(
  workflowId: string,
  scope: ExecutionEntitySelector | RunEntity,
  forms: "every" | "own"
): string[] {
  if (forms === "own") {
    const form = ownForm(scope);
    return form === undefined ? [] : [lockKey(workflowId, form)];
  }
  const keys: string[] = [];
  if (
    scope.entityType !== undefined &&
    scope.entityType !== null &&
    scope.entityId !== undefined &&
    scope.entityId !== null
  ) {
    keys.push(
      lockKey(workflowId, {
        kind: "typed",
        entityType: scope.entityType,
        entityId: scope.entityId,
      })
    );
  }
  if (scope.entityValue !== undefined && scope.entityValue !== null) {
    keys.push(
      lockKey(workflowId, { kind: "value", entityValue: scope.entityValue })
    );
  }
  return keys.toSorted();
}
