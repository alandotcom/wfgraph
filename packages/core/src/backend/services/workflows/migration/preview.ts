/**
 * Reports which in-flight runs another published version can take over.
 *
 * The report is a read: nothing moves until `migrateExecutions` is called with
 * the execution ids the caller picked out of it. Every in-flight run of the
 * workflow is classified, so a refusal is visible beside the runs that qualify.
 */

import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { annotateServiceSpan } from "#src/backend/lib/telemetry";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { classifyMigrationCandidates } from "#src/backend/services/workflows/migration/classify";
import { resolveTargetVersion } from "#src/backend/services/workflows/migration/target-version";
import type {
  WorkflowMigrationPreviewInput,
  WorkflowMigrationPreviewPayload,
} from "@wfgraph/shared/graph/migration-contracts";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow-migration").with({ workflowId })
  );

export const previewMigration = Effect.fn("wfgraph.workflow.preview_migration")(
  function* (input: WorkflowMigrationPreviewInput) {
    yield* annotateServiceSpan({ workflowId: input.workflowId });
    const targetVersion = yield* resolveTargetVersion(input);
    yield* annotateServiceSpan({ targetVersionId: targetVersion.id });

    const repo = yield* ExecutionRepo;
    const extensions = yield* Extensions;
    const classifications = yield* classifyMigrationCandidates({
      candidates: yield* repo.listInFlightByWorkflow(input.workflowId),
      targetVersion,
      catalog: extensions.catalog,
    });

    const payload: WorkflowMigrationPreviewPayload = {
      targetVersionId: targetVersion.id,
      targetVersionNumber: targetVersion.version,
      eligible: classifications
        .filter((item) => item.kind === "eligible")
        .map((item) => ({
          executionId: item.candidate.id,
          fromVersionNumber: item.candidate.versionNumber,
          // The wire shape names the nodes rather than the rows: a caller reads
          // where the run is parked and never the park's own identity.
          parkedNodeIds: item.waitStates.map((waitState) => waitState.nodeId),
        })),
      refused: classifications
        .filter((item) => item.kind === "refused")
        .map((item) =>
          omitUndefined({
            executionId: item.candidate.id,
            fromVersionNumber: item.candidate.versionNumber,
            reason: item.reason,
            detail: item.detail,
          })
        ),
      alreadyCurrentCount: classifications.filter(
        (item) => item.kind === "already_current"
      ).length,
    };

    const logger = yield* loggerFor(input.workflowId);
    yield* logger.info("Previewed a workflow migration", {
      migration: {
        eligible: payload.eligible.length,
        refused: payload.refused.length,
        alreadyCurrent: payload.alreadyCurrentCount,
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
          "Failed to preview a workflow migration"
        )
      )
    ),
  // The span's verdict, read off the answer rather than written at each site
  // that reached it. A failure names its domain kind, which is the word a
  // dashboard groups refused previews by.
  Effect.tap(() => annotateServiceSpan({ outcome: "previewed" })),
  Effect.tapError((failure) => annotateServiceSpan({ outcome: failure.kind }))
);
