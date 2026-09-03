/**
 * Machine-readable codes a structured error payload carries beside its message.
 *
 * A code is part of the wire contract: the server puts one on the failure, the
 * payload carries it as `code`, and the editor branches on it to recover. The
 * sentence beside it is for a person to read and may be reworded at any time,
 * so nothing on the client matches against message text.
 *
 * This file is the one home of those codes. A failure class in
 * `backend/lib/effect/failures.ts` names one here, and so does every reader.
 */

/** A graph naming connections that no longer resolve to what the action needs. */
export const INTEGRATION_VALIDATION_FAILED_CODE =
  "integration_validation_failed";

/** The editable workflow changed after the caller read its draft revision. */
export const DRAFT_CONFLICT_CODE = "workflow_draft_stale";

/** The two ways a publish is refused because publication moved underneath it. */
export const PUBLICATION_CONFLICT_CODES = {
  /**
   * The published version this publish was reviewed against is no longer the
   * current one, so the diff the user approved no longer describes the change.
   */
  stale: "workflow_publish_stale",
  /** The graph offered is the one already published, so there is nothing to mint. */
  alreadyPublished: "workflow_already_published",
} as const;

export type PublicationConflictCode =
  (typeof PUBLICATION_CONFLICT_CODES)[keyof typeof PUBLICATION_CONFLICT_CODES];

/**
 * The same two codes as a list, for the schema and the guard below.
 *
 * Derived rather than written out a second time: adding a key above is what
 * widens the schema the server validates with and the guard the editor branches
 * on, so the three cannot drift apart.
 */
export const PUBLICATION_CONFLICT_CODE_VALUES = Object.values(
  PUBLICATION_CONFLICT_CODES
);

/** Whether a code read off a failure payload is one of the two. */
export function isPublicationConflictCode(
  value: unknown
): value is PublicationConflictCode {
  return (
    typeof value === "string" &&
    PUBLICATION_CONFLICT_CODE_VALUES.some((code) => code === value)
  );
}
