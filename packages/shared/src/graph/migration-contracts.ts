/**
 * The wire shapes of a Migration: the preview report and the outcome of a
 * migrate call.
 *
 * A refusal reason is a machine word the client renders its own sentence for.
 * `detail` names the node or field the reason is about, never a config value.
 *
 * The seven preview reasons:
 *
 * - `draft_run`: the run pins a draft snapshot, which has no published history
 *   to move along.
 * - `executing`: the run is not parked on a Wait, so it has no point at which a
 *   later graph could take over. Asking again once it parks can succeed.
 * - `wait_node_missing`: the node the run is parked on is not an enabled Wait
 *   node in the target graph.
 * - `node_added_above_wait`: the target graph has an enabled, non-Lifecycle node
 *   outside every parked Wait's descendants with no node log row in this run.
 *   Waking would execute work before or beside a parked Wait.
 * - `waits_nested`: the run is parked on two Waits, and the target graph places
 *   one of them below the other. Each parked Wait wakes its own branch run, and
 *   the branch entered at the upper Wait would run down to the lower one and
 *   park a second time on a row the other branch already holds.
 * - `unresolved_reference`: a node at or below a parked Wait references a node
 *   that has no recorded output and is not upstream of the consuming node in
 *   the target graph. A template token inside the target Wait's own
 *   `waitTimeout` is reported the same way.
 * - `wait_timeout_elapsed`: the run is parked on an Event Wait, and the target
 *   graph's timeout for that node, resolved against this run's recorded outputs
 *   and measured from when the run parked, is already in the past. The migrated
 *   hop would time out on arrival.
 *
 * The migrate call adds one reason of its own. `not_requested_version` means
 * the guard had nothing to move: either the guarded pointer move changed no
 * row, or the run had already left the in-flight list by the time the call
 * arrived. Either way the run woke, ended, or was moved by another caller
 * between the preview and the write.
 */

import { Schema } from "effect";
import {
  listOf,
  NonEmptyTrimmedString,
  nonNegativeInteger,
  positiveInteger,
} from "#src/types/schema";

export const MIGRATION_REFUSAL_REASONS = [
  "draft_run",
  "executing",
  "wait_node_missing",
  "node_added_above_wait",
  "waits_nested",
  "unresolved_reference",
  "wait_timeout_elapsed",
] as const;

export const migrationRefusalReasonSchema = Schema.Literals(
  MIGRATION_REFUSAL_REASONS
);

export const MIGRATION_OUTCOME_REFUSAL_REASONS = [
  ...MIGRATION_REFUSAL_REASONS,
  "not_requested_version",
] as const;

export const migrationOutcomeRefusalReasonSchema = Schema.Literals(
  MIGRATION_OUTCOME_REFUSAL_REASONS
);

export const workflowMigrationPreviewInputSchema = Schema.Struct({
  workflowId: NonEmptyTrimmedString,
  /** Defaults to the workflow's current published version. */
  targetVersionId: Schema.optionalKey(NonEmptyTrimmedString),
});

/** A run the target version can take over, and where it is parked. */
export const migrationEligibleExecutionSchema = Schema.Struct({
  executionId: NonEmptyTrimmedString,
  /** Null when the run pins a draft snapshot, which carries no number. */
  fromVersionNumber: Schema.NullOr(positiveInteger),
  parkedNodeIds: listOf(NonEmptyTrimmedString),
});

export const migrationRefusedExecutionSchema = Schema.Struct({
  executionId: NonEmptyTrimmedString,
  fromVersionNumber: Schema.NullOr(positiveInteger),
  reason: migrationRefusalReasonSchema,
  /** The node id, or the node id and field key, the reason is about. */
  detail: Schema.optionalKey(NonEmptyTrimmedString),
});

export const workflowMigrationPreviewPayloadSchema = Schema.Struct({
  targetVersionId: NonEmptyTrimmedString,
  targetVersionNumber: positiveInteger,
  eligible: listOf(migrationEligibleExecutionSchema),
  refused: listOf(migrationRefusedExecutionSchema),
  /** In-flight runs already pinned to the target version. */
  alreadyCurrentCount: nonNegativeInteger,
});

export const workflowMigrationInputSchema = Schema.Struct({
  workflowId: NonEmptyTrimmedString,
  targetVersionId: NonEmptyTrimmedString,
  executionIds: listOf(NonEmptyTrimmedString).check(Schema.isMinLength(1)),
});

/**
 * What happened to one requested run. `signaled` is false when the pointer moved
 * but the wake signal was refused: the run still wakes under the target graph at
 * the target its own row already holds.
 */
export const workflowMigrationOutcomeSchema = Schema.Union([
  Schema.Struct({
    executionId: NonEmptyTrimmedString,
    status: Schema.Literal("migrated"),
    signaled: Schema.Boolean,
  }),
  Schema.Struct({
    executionId: NonEmptyTrimmedString,
    status: Schema.Literal("already_current"),
  }),
  Schema.Struct({
    executionId: NonEmptyTrimmedString,
    status: Schema.Literal("refused"),
    reason: migrationOutcomeRefusalReasonSchema,
    detail: Schema.optionalKey(NonEmptyTrimmedString),
  }),
]);

export const workflowMigrationPayloadSchema = Schema.Struct({
  targetVersionId: NonEmptyTrimmedString,
  targetVersionNumber: positiveInteger,
  outcomes: listOf(workflowMigrationOutcomeSchema),
});

export type MigrationRefusalReason = typeof migrationRefusalReasonSchema.Type;
export type MigrationOutcomeRefusalReason =
  typeof migrationOutcomeRefusalReasonSchema.Type;
export type WorkflowMigrationPreviewInput =
  typeof workflowMigrationPreviewInputSchema.Type;
export type WorkflowMigrationPreviewPayload =
  typeof workflowMigrationPreviewPayloadSchema.Type;
export type WorkflowMigrationInput = typeof workflowMigrationInputSchema.Type;
export type WorkflowMigrationOutcome =
  typeof workflowMigrationOutcomeSchema.Type;
export type WorkflowMigrationPayload =
  typeof workflowMigrationPayloadSchema.Type;
