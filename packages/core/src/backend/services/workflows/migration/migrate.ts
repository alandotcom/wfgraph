/**
 * Moves the named parked runs onto another published version of the workflow.
 *
 * Each run is reclassified first, because the preview the caller acted on is a
 * snapshot and a run can wake or end in between. A run moves in one order: the
 * pinned version pointer, then a `version-migrate` signal per parked wait row,
 * which is what makes the run recompute its Wait against the version it now
 * pins, then the audit row. The audit row is written last because it is a
 * record of the move rather than a part of it. The pointer write and the
 * signals run uninterruptibly, so a run cannot be left repinned with no signal
 * sent. A read or write that fails for one run is that run's own outcome, and
 * the rest of the batch still moves.
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
import { Extensions } from "#src/backend/lib/effect/extensions";

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

/**
 * How many runs the departed-run read asks about at once. Only a requested id
 * the in-flight list did not hold costs a read, so this bounds the rare case.
 */
const DEPARTED_RUN_READ_CONCURRENCY = 8;

/**
 * How many runs are moved at once.
 *
 * Each run costs a pointer write, a signal per parked row and an audit write,
 * and this bounds how many of those are in flight together. It does not bound
 * how many runs one call names: a call over a very large in-flight population
 * still performs every one of those writes, so it runs for as long as that
 * takes. The bound matches the classifier's output read, and each run's own
 * three steps stay in their order inside it.
 */
const MIGRATE_RUN_CONCURRENCY = 8;

/**
 * Files the audit row for a run that has already moved, and answers either way.
 *
 * The pointer has moved and the wake signal has gone out by the time this runs,
 * so a refused write costs the audit trail one row and changes nothing about
 * the run. Raising here would report a run that did migrate as a failed call.
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
            run: { executionId: input.executionId },
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

/**
 * Moves one run's version pointer and wakes the rows it is parked on.
 *
 * The two writes run uninterruptibly together. A run repinned by a fiber
 * interrupted before its signal went out would answer `already_current` on the
 * next call while still parked on the old version's schedule, and nothing else
 * would reach it.
 */
const repinAndSignal = Effect.fn("repinAndSignal")(function* (input: {
  executionId: string;
  fromVersionId: string;
  waitStates: readonly WorkflowWaitState[];
  workflowId: string;
  targetVersion: PublishedWorkflowVersion;
}) {
  const repo = yield* ExecutionRepo;

  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const moved = yield* repo.repinVersion({
        executionId: input.executionId,
        fromVersionId: input.fromVersionId,
        toVersionId: input.targetVersion.id,
      });
      if (!moved) {
        return { moved: false } as const;
      }

      const signaled = yield* signalMigratedWaits({
        executionId: input.executionId,
        waitStates: input.waitStates,
        workflowId: input.workflowId,
      });

      return { moved: true, signaled } as const;
    })
  );
});

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
      // A run repinned by an earlier call whose signal never went out is still
      // parked on the schedule its old version computed, and this is the one
      // thing that wakes it under the version it now pins. A run parked on
      // nothing is left alone, and a redundant signal costs the Wait one attempt.
      yield* Effect.uninterruptible(
        signalMigratedWaits({
          executionId,
          waitStates: classification.waitStates,
          workflowId: input.workflowId,
        })
      );

      return {
        executionId,
        status: "already_current",
      } satisfies WorkflowMigrationOutcome;
    }

    const move = yield* repinAndSignal({
      executionId,
      fromVersionId: classification.candidate.workflowVersionId,
      waitStates: classification.waitStates,
      workflowId: input.workflowId,
      targetVersion,
    });
    if (!move.moved) {
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
      signaled: move.signaled,
    } satisfies WorkflowMigrationOutcome;
  },
  // A read or write this run needed was refused. The run stays on the version
  // it pinned, and the batch carries on, so a later call can move it.
  (effect, input) =>
    effect.pipe(
      Effect.catchTag("DatabaseError", (failure) =>
        Effect.gen(function* () {
          const logger = yield* loggerFor(input.workflowId);
          yield* logger.error("Failed to migrate a workflow run", {
            run: { executionId: input.classification.candidate.id },
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
