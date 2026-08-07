/**
 * Publish: mint (or reuse) an immutable workflow version from the editor graph,
 * rewrite the event subscription index from that graph, and point the workflow
 * at it so starts use it.
 */

import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { Extensions } from "#src/backend/lib/effect/extensions";
import {
  Conflict,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
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

const STALE_PUBLISH_MESSAGE =
  "This workflow was published elsewhere. Refresh and try again.";

/**
 * Publish the graph the editor sent as an immutable version.
 *
 * Runs the ordinary graph+catalog battery plus the publish-only unreachable-
 * subtree check. A Canceled branch with no Cancel Event is drawable and never
 * entered; the editor shows it inactive rather than refusing publish. Content-
 * hash dedupe reuses any prior version with the same digest and fingerprint, so
 * an idle editor does not accrete rows — that path only re-points the workflow
 * and rewrites subscriptions. A new version number is read outside the write and
 * claimed optimistically; if another publish took it, the caller is told to
 * refresh. Draft saves leave the subscription index alone. The draft column is
 * aligned to the published graph in the same write.
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

    const draftGraph = prepared.graph;
    const eventSubscriptions = prepared.subscriptionsFor(workflowId);

    const published = matching
      ? yield* repo.setPublishedVersion({
          workflowId,
          versionId: matching.id,
          draftGraph,
          eventSubscriptions,
        })
      : yield* Effect.gen(function* () {
          // Optimistic concurrency: read the current version outside the write,
          // then claim current+1. If that number was taken, we are behind.
          const latest = yield* repo.findLatestVersion(workflowId);
          const expectedVersion = (latest?.version ?? 0) + 1;
          const inserted = yield* repo.insertPublishedVersion({
            workflowId,
            versionId: generateId(),
            version: expectedVersion,
            graph: prepared.graph,
            catalogFingerprint: fingerprint,
            graphDigest: digest,
            draftGraph,
            eventSubscriptions,
          });
          if (inserted && "stale" in inserted) {
            yield* logger.warn("Rejected workflow publish: version race", {
              expectedVersion,
            });
            return yield* new Conflict({ error: STALE_PUBLISH_MESSAGE });
          }
          return inserted;
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
      ...toWorkflowApiPayload(published.workflow, published.version),
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
