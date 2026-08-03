/**
 * Publish: mint (or reuse) an immutable workflow version from the current draft,
 * rewrite the event subscription index from that graph, and point the workflow
 * at it so starts use it.
 */

import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { InvalidInput, NotFound } from "#src/backend/lib/effect/failures";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/internal-failure";
import { prepareGraphSave } from "#src/backend/services/workflows/graph-save";
import { toWorkflowApiPayload } from "#src/backend/services/workflows/mappers";
import type { WorkflowPublishPayload } from "@rova/shared/graph/api-contracts";
import {
  checkCanceledBranchNeedsCancelEvent,
  checkUnreachableSubtrees,
} from "#src/backend/services/workflows/publish-checks";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  catalogFingerprint,
  graphDigest,
} from "#src/backend/services/workflows/version-digest";
import { generateId } from "@rova/shared/utils/id";

const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "publish").with({ workflowId })
  );

/**
 * Publish the workflow's current draft as an immutable version.
 *
 * Runs the ordinary graph+catalog battery plus the publish-only checks
 * (unreachable subtrees, Canceled branch without a Cancel Event). Content-hash
 * dedupe reuses the latest version when the digest and fingerprint match, so an
 * idle editor does not accrete rows. The subscription index is rewritten from
 * the published graph only -- draft saves leave it alone.
 */
export const publishWorkflow = Effect.fn("publishWorkflow")(
  function* (workflowId: string) {
    const repo = yield* WorkflowRepo;
    const { catalog } = yield* Extensions;
    const logger = yield* loggerFor(workflowId);

    const workflow = yield* repo.findById(workflowId);
    if (!workflow) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    const prepared = yield* prepareGraphSave({ graph: workflow.graph }).pipe(
      Effect.tapError((failure) =>
        "error" in failure
          ? logger.warn("Rejected workflow publish", { error: failure.error })
          : Effect.void
      )
    );

    for (const check of [
      () =>
        checkUnreachableSubtrees({
          nodes: prepared.nodes,
          edges: prepared.edges,
        }),
      () =>
        checkCanceledBranchNeedsCancelEvent({
          nodes: prepared.nodes,
          edges: prepared.edges,
        }),
    ]) {
      const result = check();
      if (!result.valid) {
        yield* logger.warn("Rejected workflow publish", {
          error: result.error,
        });
        return yield* new InvalidInput({ error: result.error });
      }
    }

    const digest = graphDigest(prepared.graph);
    const fingerprint = catalogFingerprint(catalog);
    const latest = yield* repo.findLatestVersion(workflowId);

    if (
      latest &&
      latest.graphDigest === digest &&
      latest.catalogFingerprint === fingerprint
    ) {
      const pointed = yield* repo.setPublishedVersion({
        workflowId,
        versionId: latest.id,
        eventSubscriptions: prepared.subscriptionsFor(workflowId),
      });
      if (!pointed) {
        return yield* new NotFound({ error: "Workflow not found" });
      }

      yield* logger.info("Workflow publish reused existing version", {
        versionId: latest.id,
        version: latest.version,
      });

      const payload: WorkflowPublishPayload = {
        ...toWorkflowApiPayload(pointed),
        publishedVersionId: latest.id,
        publishedVersion: latest.version,
      };
      return payload;
    }

    const nextVersion = (latest?.version ?? 0) + 1;
    const versionId = generateId();
    const published = yield* repo.insertVersionAndPublish({
      workflowId,
      version: {
        id: versionId,
        version: nextVersion,
        graph: prepared.graph,
        catalogFingerprint: fingerprint,
        graphDigest: digest,
      },
      eventSubscriptions: prepared.subscriptionsFor(workflowId),
    });

    if (!published) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    yield* logger.info("Workflow published", {
      versionId,
      version: nextVersion,
      nodeCount: prepared.nodes.length,
    });

    const payload: WorkflowPublishPayload = {
      ...toWorkflowApiPayload(published.workflow),
      publishedVersionId: published.version.id,
      publishedVersion: published.version.version,
    };
    return payload;
  },
  (effect, workflowId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          loggerFor(workflowId),
          "Failed to publish workflow"
        )
      )
    )
);
