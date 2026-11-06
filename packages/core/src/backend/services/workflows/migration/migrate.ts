/**
 * Moves the named parked runs onto another published version of the workflow.
 *
 * Each run is reclassified first, because the preview the caller acted on is a
 * snapshot and a run can wake or end in between. A run moves in one write
 * (`ExecutionDriver.migrateRun`): the pinned version pointer, a `migrate` wake
 * on every park, which is what makes the run prepare its Wait again against
 * the version it now pins, and the run re-queued. The audit row follows,
 * because it is a record of the move rather than a part of it. A read or write
 * that fails for one run is that run's own outcome, and the rest of the batch
 * still moves.
 */

import { Effect } from "effect";
import { countBy, uniq } from "es-toolkit/array";
import { isNotNil } from "es-toolkit/predicate";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { InvalidInput } from "#src/backend/lib/effect/failures";
import { annotateServiceSpan } from "#src/backend/lib/telemetry";
import type { PublishedWorkflowVersion } from "#src/backend/lib/db/schema";
import { ExecutionDriver } from "#src/backend/services/executions/driver";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
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
import { Extensions } from "#src/backend/lib/effect/extensions";

const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow-migration").with({ workflowId })
  );

/**
 * How many runs the departed-run read asks about at once. Only a requested id
 * the in-flight list did not hold costs a read, so this bounds the rare case.
 */
const DEPARTED_RUN_READ_CONCURRENCY = 8;

/**
 * How many runs are moved at once.
 *
 * Each run costs a repin transaction and an audit write, and this bounds how
 * many of those are in flight together. It does not bound how many runs one
 * call names: a call over a very large in-flight population still performs
 * every one of those writes, so it runs for as long as that takes. The bound
 * matches the classifier's output read, and each run's own two writes stay in
 * their order inside it.
 */
const MIGRATE_RUN_CONCURRENCY = 8;

/**
 * Files the audit row for a run that has already moved, and answers either way.
 *
 * The pointer has moved and the parks have their `migrate` wake by the time
 * this runs, so a refused write costs the audit trail one row and changes
 * nothing about the run. Raising here would report a run that did migrate as a
 * failed call.
 */
const recordMigrationAudit = Effect.fn("recordMigrationAudit")(
  function* (input: {
    executionId: string;
    workflowId: string;
    fromVersionId: string;
    fromVersionNumber: number | null;
    targetVersion: PublishedWorkflowVersion;
  }) {
    const repo = yield* ExecutionRepo;
    const logger = yield* loggerFor(input.workflowId);

    yield* repo
      .recordAuditEvent({
        workflowId: input.workflowId,
        executionId: input.executionId,
        eventType: "run_migrated",
        message: `Run migrated to version ${input.targetVersion.version}`,
        metadata: {
          fromVersionId: input.fromVersionId,
          fromVersionNumber: input.fromVersionNumber,
          toVersionId: input.targetVersion.id,
          toVersionNumber: input.targetVersion.version,
        },
      })
      .pipe(
        Effect.catchTag("DatabaseError", (failure) =>
          logger.error("Failed to record a run migration", {
            run: { execution: input.executionId },
            error: failure.cause,
          })
        )
      );
  }
);

/**
 * Answers the requested ids the in-flight list did not hold, and refuses the
 * whole call when one of them names a run of another workflow.
 *
 * Two cases arrive here and they answer differently. An id naming no run of
 * this workflow was built against something other than this workflow's
 * preview, so the whole call is refused. A run of this workflow that is no
 * longer in flight woke, ended, or was cancelled between the preview and this
 * call, and is answered as one refused run so the rest of the batch still
 * moves.
 */
const acceptDepartedRunIds = Effect.fn("acceptDepartedRunIds")(
  function* (input: { missingIds: readonly string[]; workflowId: string }) {
    const repo = yield* ExecutionRepo;
    const owners = yield* Effect.forEach(
      input.missingIds,
      (executionId) =>
        Effect.map(repo.findWorkflowIdById(executionId), (workflowId) => ({
          executionId,
          workflowId,
        })),
      { concurrency: DEPARTED_RUN_READ_CONCURRENCY }
    );

    const foreign = owners.filter(
      (owner) => owner.workflowId !== input.workflowId
    );
    if (foreign.length > 0) {
      return yield* new InvalidInput({
        error: `${foreign.length} of the requested runs are not runs of this workflow`,
      });
    }

    return input.missingIds;
  }
);

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
const migrateOne = Effect.fn("migrateOne")(
  function* (input: {
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
      // The repin that moved this run wrote its `migrate` wakes in the same
      // transaction, so there is nothing left to wake.
      return {
        executionId,
        status: "already_current",
      } satisfies WorkflowMigrationOutcome;
    }

    const driver = yield* ExecutionDriver;
    const moved = yield* driver.migrateRun({
      executionId,
      fromVersionId: classification.candidate.workflowVersionId,
      toVersionId: targetVersion.id,
      expectedWaitStates: classification.waitStates.map(
        ({ id, resumeToken }) => ({ id, resumeToken })
      ),
    });
    if (!moved) {
      return refusedOutcome({ executionId, reason: "not_requested_version" });
    }

    yield* recordMigrationAudit({
      executionId,
      workflowId: input.workflowId,
      fromVersionId: classification.candidate.workflowVersionId,
      fromVersionNumber: classification.candidate.versionNumber,
      targetVersion,
    });
    return {
      executionId,
      status: "migrated",
    } satisfies WorkflowMigrationOutcome;
  },
  // The repin was refused. The run stays on the version it pinned, and the
  // batch carries on, so a later call can move it.
  (effect, input) =>
    effect.pipe(
      Effect.catchTag("DriverError", (failure) =>
        Effect.gen(function* () {
          const logger = yield* loggerFor(input.workflowId);
          yield* logger.error("Failed to migrate a workflow run", {
            run: { execution: input.classification.candidate.id },
            error: failure.cause,
          });

          return {
            executionId: input.classification.candidate.id,
            status: "failed",
          } satisfies WorkflowMigrationOutcome;
        })
      )
    )
);

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
    const departedIds = yield* acceptDepartedRunIds({
      missingIds: requestedIds.filter(
        (executionId) => !inFlightById.has(executionId)
      ),
      workflowId: input.workflowId,
    });

    const extensions = yield* Extensions;
    const classifications = yield* classifyMigrationCandidates({
      candidates,
      targetVersion,
      catalog: extensions.catalog,
    });

    const classifiedOutcomes = yield* Effect.forEach(
      classifications,
      (classification) =>
        migrateOne({
          classification,
          workflowId: input.workflowId,
          targetVersion,
        }),
      { concurrency: MIGRATE_RUN_CONCURRENCY }
    );
    const outcomes = [
      ...classifiedOutcomes,
      ...departedIds.map((executionId) =>
        refusedOutcome({ executionId, reason: "not_requested_version" })
      ),
    ];

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
        failed: byStatus.failed ?? 0,
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
