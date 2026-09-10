/**
 * The wire shapes of a Migration: the preview report and the outcome of a
 * migrate call.
 *
 * A refusal reason is a machine word the client renders its own sentence for.
 * `detail` names the node or field the reason is about, never a config value.
 *
 * The five preview reasons:
 *
 * - `draft_run`: the run pins a draft snapshot, which has no published history
 *   to move along.
 * - `executing`: the run is not parked on a Wait, so it has no point at which a
 *   later graph could take over. Asking again once it parks can succeed.
 * - `wait_node_missing`: the node the run is parked on is not an enabled Wait
 *   node in the target graph.
 * - `unresolved_reference`: a node below the parked Wait in the target graph
 *   references a node that neither runs below one of this run's parked Waits
 *   nor left an output in this run.
 * - `wait_timeout_elapsed`: the run is parked on an Event Wait, and the target
 *   graph's timeout for that node, measured from when the run parked, is
 *   already in the past. The migrated hop would time out on arrival.
 *
 * The migrate call adds one reason of its own. `not_requested_version` means
 * the guarded pointer move changed no row, so the run woke, ended, or was moved
 * by another caller between the classification and the write.
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

/** How many runs one migrate call may name. */
export const MIGRATION_EXECUTION_IDS_LIMIT = 500;

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
  executionIds: listOf(NonEmptyTrimmedString).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MIGRATION_EXECUTION_IDS_LIMIT)
  ),
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
