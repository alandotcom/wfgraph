/**
 * Publish mints an immutable workflow version from the editor graph, rewrites
 * the event subscription index from that graph, and points the workflow at it.
 */

import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { Conflict, NotFound } from "#src/backend/lib/effect/failures";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { prepareGraphSave } from "#src/backend/services/workflows/graph-save";
import { toWorkflowApiPayload } from "#src/backend/services/workflows/mappers";
import type { WorkflowPublishPayload } from "@wfgraph/shared/graph/api-contracts";
import type { WorkflowPublishInput } from "@wfgraph/shared/graph/publication-contracts";
import { checkPublishReadiness } from "#src/backend/services/workflows/publish-checks";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  catalogFingerprint,
  graphDigest,
} from "#src/backend/services/workflows/version-digest";
import { semanticWorkflowGraphsEqual } from "#src/backend/services/workflows/semantic-graph";
import { generateId } from "@wfgraph/shared/utils/id";

const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("publish").with({ workflowId })
  );

const STALE_PUBLISH_MESSAGE =
  "This workflow was published elsewhere. Refresh and try again.";
const CURRENT_GRAPH_PUBLISHED_MESSAGE =
  "This workflow graph is already published.";

/**
 * Publish the graph the editor sent as an immutable version.
 *
 * Runs the graph's shape battery and then the readiness battery, which draft
 * save does not ask for. A Canceled branch with no Cancel Event is drawable and
 * inactive. Publishing the graph already current is refused. Every other
 * confirmed publish claims the current maximum version plus one.
 */
export const publishWorkflow = Effect.fn("publishWorkflow")(
  function* (input: WorkflowPublishInput) {
    const { workflowId, graph, expectedPublishedVersionId } = input;
    const repo = yield* WorkflowRepo;
    const { catalog } = yield* Extensions;
    const logger = yield* loggerFor(workflowId);

    const workflow = yield* repo.findById(workflowId);
    if (!workflow) {
      return yield* new NotFound({ error: "Workflow not found" });
    }
    if (workflow.publishedVersionId !== expectedPublishedVersionId) {
      return yield* new Conflict({ error: STALE_PUBLISH_MESSAGE });
    }

    const prepared = yield* prepareGraphSave({ graph }).pipe(
      Effect.tapError((failure) =>
        "error" in failure
          ? logger.warn("Rejected workflow publish", { error: failure.error })
          : Effect.void
      )
    );

    yield* checkPublishReadiness({
      nodes: prepared.nodes,
      edges: prepared.edges,
    }).pipe(
      Effect.tapError((failure) =>
        "error" in failure
          ? logger.warn("Rejected workflow publish", { error: failure.error })
          : Effect.void
      )
    );

    const digest = graphDigest(prepared.graph);
    const fingerprint = catalogFingerprint(catalog);
    const current = yield* repo.findPublishedVersion(workflowId);
    if ((current?.id ?? null) !== expectedPublishedVersionId) {
      return yield* new Conflict({ error: STALE_PUBLISH_MESSAGE });
    }
    if (current && semanticWorkflowGraphsEqual(current.graph, prepared.graph)) {
      return yield* new Conflict({ error: CURRENT_GRAPH_PUBLISHED_MESSAGE });
    }

    const latest = yield* repo.findLatestVersion(workflowId);
    const expectedVersion = (latest?.version ?? 0) + 1;
    const published = yield* repo.insertPublishedVersion({
      workflowId,
      versionId: generateId(),
      version: expectedVersion,
      expectedPublishedVersionId,
      graph: prepared.graph,
      catalogFingerprint: fingerprint,
      graphDigest: digest,
      draftGraph: prepared.graph,
      eventSubscriptions: prepared.subscriptionsFor(workflowId),
    });
    if (published && "stale" in published) {
      yield* logger.warn("Rejected workflow publish: version race", {
        expectedVersion,
      });
      return yield* new Conflict({ error: STALE_PUBLISH_MESSAGE });
    }
    if (!published) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    yield* logger.info("Workflow published", {
      version: {
        id: published.version.id,
        number: published.version.version,
        nodes: prepared.nodes.length,
      },
    });

    const payload: WorkflowPublishPayload = {
      ...toWorkflowApiPayload(published.workflow, published.version),
      publishedVersionId: published.version.id,
      publishedVersion: published.version.version,
      publishedAt: published.version.publishedAt.toISOString(),
    };
    return payload;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(input.workflowId),
          "Failed to publish workflow"
        )
      )
    )
);
