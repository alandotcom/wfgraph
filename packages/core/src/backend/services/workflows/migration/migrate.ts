/**
 * Moves the named parked runs onto a later published version.
 *
 * Each run is reclassified first, because the preview the caller acted on is a
 * snapshot and a run can wake or end in between. A run moves in one order:
 * the pinned version pointer, then the audit row, then a `version-migrate`
 * signal per parked wait row, which is what makes the run recompute its Wait
 * against the version it now pins.
 */

import { Effect } from "effect";
import { countBy, uniq } from "es-toolkit/array";
import { isNotNil } from "es-toolkit/predicate";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { InvalidInput } from "#src/backend/lib/effect/failures";
import { annotateServiceSpan } from "#src/backend/lib/telemetry";
import type { PublishedWorkflowVersion } from "#src/backend/lib/db/schema";
import {
  ExecutionRepo,
  type WorkflowWaitState,
} from "#src/backend/services/executions/repo";
import {
  classifyMigrationCandidates,
  type MigrationClassification,
} from "#src/backend/services/workflows/migration/classify";
import { resolveTargetVersion } from "#src/backend/services/workflows/migration/target-version";
import type {
  MigrationOutcomeRefusalReason,
  WorkflowMigrationInput,
  WorkflowMigrationOutcome,
  WorkflowMigrationPayload,
} from "@wfgraph/shared/graph/migration-contracts";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow-migration").with({ workflowId })
  );

/**
 * Wakes every wait row the run is parked on, answering whether all of them were
 * signaled.
 *
 * A refused send is logged rather than raised: the pointer has already moved, so
 * the run reads the target version's graph when its own park ends.
 */
const signalMigratedWaits = Effect.fn("signalMigratedWaits")(function* (input: {
  executionId: string;
  waitStates: readonly WorkflowWaitState[];
  workflowId: string;
}) {
  const inngest = yield* InngestClient;
  const logger = yield* loggerFor(input.workflowId);

  const sent = yield* Effect.forEach(input.waitStates, (waitState) =>
    inngest
      .sendWaitSignal({
        executionId: input.executionId,
        nodeId: waitState.nodeId,
        token: waitState.resumeToken,
        signalType: "version-migrate",
      })
      .pipe(
        Effect.as(true),
        Effect.catchTag("InngestError", (failure) =>
          logger
            .error("Failed to signal a migrated wait", {
              run: { executionId: input.executionId },
              node: { waitStateId: waitState.id, nodeId: waitState.nodeId },
              error: failure.cause,
            })
            .pipe(Effect.as(false))
        )
      )
  );

  return sent.every((signaled) => signaled);
});

function refusedOutcome(input: {
  executionId: string;
  reason: MigrationOutcomeRefusalReason;
  detail?: string | undefined;
}): WorkflowMigrationOutcome {
  return omitUndefined({
    executionId: input.executionId,
    status: "refused" as const,
    reason: input.reason,
    detail: input.detail,
  });
}

/** Acts on one classification, and answers what happened to that run. */
const migrateOne = Effect.fn("migrateOne")(function* (input: {
  classification: MigrationClassification;
  workflowId: string;
  targetVersion: PublishedWorkflowVersion;
}) {
  const { classification, targetVersion } = input;
  const executionId = classification.candidate.id;

  if (classification.kind === "refused") {
    return refusedOutcome({
      executionId,
      reason: classification.reason,
      detail: classification.detail,
    });
  }

  if (classification.kind === "already_current") {
    const alreadyCurrent: WorkflowMigrationOutcome = {
      executionId,
      status: "already_current",
    };
    return alreadyCurrent;
  }

  const repo = yield* ExecutionRepo;
  const moved = yield* repo.repinVersion({
    executionId,
    fromVersionId: classification.candidate.workflowVersionId,
    toVersionId: targetVersion.id,
  });
  if (!moved) {
    return refusedOutcome({ executionId, reason: "not_requested_version" });
  }

  yield* repo.recordAuditEvent({
    workflowId: input.workflowId,
    executionId,
    eventType: "run_migrated",
    message: `Run migrated to version ${targetVersion.version}`,
    metadata: {
      fromVersionId: classification.candidate.workflowVersionId,
      fromVersionNumber: classification.candidate.versionNumber,
      toVersionId: targetVersion.id,
      toVersionNumber: targetVersion.version,
    },
  });

  const signaled = yield* signalMigratedWaits({
    executionId,
    waitStates: classification.waitStates,
    workflowId: input.workflowId,
  });
  const migrated: WorkflowMigrationOutcome = {
    executionId,
    status: "migrated",
    signaled,
  };
  return migrated;
});

export const migrateExecutions = Effect.fn("wfgraph.workflow.migrate_runs")(
  function* (input: WorkflowMigrationInput) {
    yield* annotateServiceSpan({ workflowId: input.workflowId });
    const targetVersion = yield* resolveTargetVersion(input);
    yield* annotateServiceSpan({ targetVersionId: targetVersion.id });
    const repo = yield* ExecutionRepo;

    const requestedIds = uniq(input.executionIds);
    const inFlightById = new Map(
      (yield* repo.listInFlightByWorkflow(input.workflowId)).map((row) => [
        row.id,
        row,
      ])
    );
    const candidates = requestedIds
      .map((executionId) => inFlightById.get(executionId))
      .filter(isNotNil);
    // The whole call is refused rather than each unknown id, because a request
    // naming a run this workflow does not have in flight was built against
    // something other than this workflow's preview.
    const unknownCount = requestedIds.length - candidates.length;
    if (unknownCount > 0) {
      return yield* new InvalidInput({
        error: `${unknownCount} of the requested runs are not in-flight runs of this workflow`,
      });
    }

    const classifications = yield* classifyMigrationCandidates({
      candidates,
      targetVersion,
    });

    const outcomes = yield* Effect.forEach(classifications, (classification) =>
      migrateOne({
        classification,
        workflowId: input.workflowId,
        targetVersion,
      })
    );

    const payload: WorkflowMigrationPayload = {
      targetVersionId: targetVersion.id,
      targetVersionNumber: targetVersion.version,
      outcomes,
    };

    const byStatus = countBy(outcomes, (outcome) => outcome.status);
    const logger = yield* loggerFor(input.workflowId);
    yield* logger.info("Migrated workflow runs", {
      migration: {
        migrated: byStatus.migrated ?? 0,
        refused: byStatus.refused ?? 0,
        alreadyCurrent: byStatus.already_current ?? 0,
      },
    });
    return payload;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(input.workflowId),
          "Failed to migrate workflow runs"
        )
      )
    ),
  // The span's verdict, read off the answer rather than written at each site
  // that reached it. A failure names its domain kind, which is the word a
  // dashboard groups refused migrations by.
  Effect.tap(() => annotateServiceSpan({ outcome: "migrated" })),
  Effect.tapError((failure) => annotateServiceSpan({ outcome: failure.kind }))
);
