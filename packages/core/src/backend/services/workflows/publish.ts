/**
 * Publish: mint (or reuse) an immutable workflow version from the editor graph,
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
import type { SerializedWorkflowGraph } from "@rova/shared/graph/types";
import { checkUnreachableSubtrees } from "#src/backend/services/workflows/publish-checks";
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

const publishOnlyChecks = [checkUnreachableSubtrees] as const;

/**
 * Publish the graph the editor sent as an immutable version.
 *
 * Runs the ordinary graph+catalog battery plus the publish-only unreachable-
 * subtree check. A Canceled branch with no Cancel Event is drawable and never
 * entered; the editor shows it inactive rather than refusing publish. Content-
 * hash dedupe reuses any prior version with the same digest and fingerprint, so
 * an idle editor does not accrete rows. Concurrent mints recover inside
 * `publishVersion` rather than answering 500. The subscription index is rewritten from
 * the published graph only -- draft saves leave it alone. The draft column is
 * aligned to the published graph in the same transaction.
 */
export const publishWorkflow = Effect.fn("publishWorkflow")(
  function* (input: { workflowId: string; graph: SerializedWorkflowGraph }) {
    const { workflowId, graph } = input;
    const repo = yield* WorkflowRepo;
    const { catalog } = yield* Extensions;
    const logger = yield* loggerFor(workflowId);

    const workflow = yield* repo.findById(workflowId);
    if (!workflow) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    const prepared = yield* prepareGraphSave({ graph }).pipe(
      Effect.tapError((failure) =>
        "error" in failure
          ? logger.warn("Rejected workflow publish", { error: failure.error })
          : Effect.void
      )
    );

    for (const check of publishOnlyChecks) {
      const result = check({
        nodes: prepared.nodes,
        edges: prepared.edges,
      });
      if (!result.valid) {
        yield* logger.warn("Rejected workflow publish", {
          error: result.error,
        });
        return yield* new InvalidInput({ error: result.error });
      }
    }

    const digest = graphDigest(prepared.graph);
    const fingerprint = catalogFingerprint(catalog);
    const matching = yield* repo.findVersionByContent({
      workflowId,
      graphDigest: digest,
      catalogFingerprint: fingerprint,
    });

    const published = matching
      ? yield* repo.publishVersion({
          workflowId,
          versionId: matching.id,
          draftGraph: prepared.graph,
          eventSubscriptions: prepared.subscriptionsFor(workflowId),
        })
      : yield* repo.publishVersion({
          workflowId,
          versionId: generateId(),
          mint: {
            graph: prepared.graph,
            catalogFingerprint: fingerprint,
            graphDigest: digest,
          },
          draftGraph: prepared.graph,
          eventSubscriptions: prepared.subscriptionsFor(workflowId),
        });

    if (!published) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    yield* logger.info(
      matching
        ? "Workflow publish reused existing version"
        : "Workflow published",
      {
        versionId: published.version.id,
        version: published.version.version,
        ...(matching ? {} : { nodeCount: prepared.nodes.length }),
      }
    );

    const payload: WorkflowPublishPayload = {
      ...toWorkflowApiPayload(published.workflow),
      publishedVersionId: published.version.id,
      publishedVersion: published.version.version,
    };
    return payload;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          loggerFor(input.workflowId),
          "Failed to publish workflow"
        )
      )
    )
);
