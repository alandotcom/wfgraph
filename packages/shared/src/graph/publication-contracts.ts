import { Schema } from "effect";
import { serializedWorkflowGraphSchema } from "#src/graph/schemas";
import { listOf, NonEmptyTrimmedString } from "#src/types/schema";
import { isoTimestampString } from "#src/types/timestamp";

const positiveInteger = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
);

const nonNegativeInteger = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
);

export const WORKFLOW_VERSION_HISTORY_DEFAULT_LIMIT = 25;
export const WORKFLOW_VERSION_HISTORY_MAX_LIMIT = 100;

export const workflowVersionCursorSchema = Schema.Struct({
  version: positiveInteger,
});

export const workflowVersionSummarySchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  version: positiveInteger,
  publishedAt: isoTimestampString(),
  isCurrent: Schema.Boolean,
});

export const workflowVersionHistoryInputSchema = Schema.Struct({
  workflowId: NonEmptyTrimmedString,
  limit: Schema.optionalKey(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isBetween({
        minimum: 1,
        maximum: WORKFLOW_VERSION_HISTORY_MAX_LIMIT,
      })
    )
  ),
  cursor: Schema.optionalKey(workflowVersionCursorSchema),
});

export const workflowVersionHistoryPayloadSchema = Schema.Struct({
  items: listOf(workflowVersionSummarySchema),
  nextCursor: Schema.NullOr(workflowVersionCursorSchema),
});

export const workflowVersionUsageInputSchema = Schema.Struct({
  workflowId: NonEmptyTrimmedString,
});

const workflowVersionUsageFields = {
  id: NonEmptyTrimmedString,
  publishedAt: isoTimestampString(),
  isCurrent: Schema.Boolean,
  activeRunCount: nonNegativeInteger,
  oldestActiveRunAt: Schema.NullOr(isoTimestampString()),
  actionIds: listOf(NonEmptyTrimmedString),
  missingActionIds: listOf(NonEmptyTrimmedString),
  catalogMatches: Schema.Boolean,
};

export const workflowVersionUsageItemSchema = Schema.Union([
  Schema.Struct({
    ...workflowVersionUsageFields,
    kind: Schema.Literal("published"),
    version: positiveInteger,
  }),
  Schema.Struct({
    ...workflowVersionUsageFields,
    kind: Schema.Literal("draft_snapshot"),
    version: Schema.Null,
  }),
]);

export const workflowVersionUsagePayloadSchema = Schema.Struct({
  items: listOf(workflowVersionUsageItemSchema),
});

export type WorkflowVersionUsageInput =
  typeof workflowVersionUsageInputSchema.Type;
export type WorkflowVersionUsageItem =
  typeof workflowVersionUsageItemSchema.Type;
export type WorkflowVersionUsagePayload =
  typeof workflowVersionUsagePayloadSchema.Type;

export const workflowComparisonInputSchema = Schema.Struct({
  workflowId: NonEmptyTrimmedString,
  /** Defaults to the current publication; absent before version 1. */
  baseVersionId: Schema.optionalKey(NonEmptyTrimmedString),
  /** The exact graph visible in the editor, including edits still awaiting autosave. */
  draftGraph: serializedWorkflowGraphSchema,
});

/** The graph and publication pointer the editor reviewed before confirmation. */
export const workflowPublishInputSchema = Schema.Struct({
  workflowId: NonEmptyTrimmedString,
  graph: serializedWorkflowGraphSchema,
  expectedDraftRevision: Schema.Finite.check(
    Schema.isInt(),
    Schema.isGreaterThan(0)
  ),
  /** Null only when the review was for the workflow's first publication. */
  expectedPublishedVersionId: Schema.NullOr(NonEmptyTrimmedString),
});

export const workflowRestoreVersionInputSchema = Schema.Struct({
  workflowId: NonEmptyTrimmedString,
  versionId: NonEmptyTrimmedString,
  expectedDraftRevision: Schema.Finite.check(
    Schema.isInt(),
    Schema.isGreaterThan(0)
  ),
});

export const workflowFieldChangeSchema = Schema.Struct({
  /** Machine-readable path. The client resolves catalog field labels for display. */
  path: listOf(NonEmptyTrimmedString).check(Schema.isMinLength(1)),
  kind: Schema.Literals(["added", "modified", "removed"]),
  before: Schema.optionalKey(Schema.MutableJson),
  after: Schema.optionalKey(Schema.MutableJson),
});

export const workflowNodeChangeSchema = Schema.Struct({
  nodeId: NonEmptyTrimmedString,
  kind: Schema.Literals(["added", "modified", "removed"]),
  fields: listOf(workflowFieldChangeSchema),
});

/**
 * Edge changes are additions and removals by semantic edge identity. A changed
 * endpoint, handle, or data value appears as one removal and one addition.
 */
export const workflowEdgeChangeSchema = Schema.Struct({
  edgeId: NonEmptyTrimmedString,
  kind: Schema.Literals(["added", "removed"]),
});

/**
 * A safe comparison of one immutable version with the exact draft sent by the
 * editor. Both graphs and every field value have passed the workflow redactor.
 */
export const workflowComparisonPayloadSchema = Schema.Struct({
  /** Null when the draft is being reviewed for its first publication. */
  baseVersion: Schema.NullOr(workflowVersionSummarySchema),
  proposedVersion: positiveInteger,
  baseGraph: serializedWorkflowGraphSchema,
  draftGraph: serializedWorkflowGraphSchema,
  hasChanges: Schema.Boolean,
  nodeChanges: listOf(workflowNodeChangeSchema),
  edgeChanges: listOf(workflowEdgeChangeSchema),
});

export type WorkflowVersionCursor = typeof workflowVersionCursorSchema.Type;
export type WorkflowVersionSummary = typeof workflowVersionSummarySchema.Type;
export type WorkflowVersionHistoryInput =
  typeof workflowVersionHistoryInputSchema.Type;
export type WorkflowVersionHistoryPayload =
  typeof workflowVersionHistoryPayloadSchema.Type;
export type WorkflowComparisonInput = typeof workflowComparisonInputSchema.Type;
export type WorkflowPublishInput = typeof workflowPublishInputSchema.Type;
export type WorkflowRestoreVersionInput =
  typeof workflowRestoreVersionInputSchema.Type;
export type WorkflowFieldChange = typeof workflowFieldChangeSchema.Type;
export type WorkflowNodeChange = typeof workflowNodeChangeSchema.Type;
export type WorkflowEdgeChange = typeof workflowEdgeChangeSchema.Type;
export type WorkflowComparisonPayload =
  typeof workflowComparisonPayloadSchema.Type;
