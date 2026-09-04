/**
 * Publish mints an immutable workflow version from the editor graph, rewrites
 * the event subscription index from that graph, and points the workflow at it.
 */

import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { Extensions } from "#src/backend/lib/effect/extensions";
import {
  DraftConflict,
  NotFound,
  PublicationConflict,
} from "#src/backend/lib/effect/failures";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { annotateServiceSpan } from "#src/backend/lib/telemetry";
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
import { PUBLICATION_CONFLICT_CODES } from "@wfgraph/shared/rpc/error-codes";

// Three branches refuse a publish whose expectedPublishedVersionId no longer
// matches the row; they share one sentence and one code.
const stalePublish = () =>
  new PublicationConflict({
    error: "This workflow was published elsewhere. Refresh and try again.",
    code: PUBLICATION_CONFLICT_CODES.stale,
  });

const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("publish").with({ workflowId })
  );

/**
 * Publish the graph the editor sent as an immutable version.
 *
 * Runs the graph's shape battery and then the readiness battery, which draft
 * save does not ask for. A Canceled branch with no Cancel Event is drawable and
 * inactive. Publishing the graph already current is refused. Every other
 * confirmed publish claims the current maximum version plus one.
 */
export const publishWorkflow = Effect.fn("wfgraph.workflow.publish")(
  function* (input: WorkflowPublishInput) {
    const {
      workflowId,
      graph,
      expectedPublishedVersionId,
      expectedDraftRevision,
    } = input;
    yield* annotateServiceSpan({ workflowId });
    const repo = yield* WorkflowRepo;
    const { catalog } = yield* Extensions;
    const logger = yield* loggerFor(workflowId);

    const workflow = yield* repo.findById(workflowId);
    if (!workflow) {
      return yield* new NotFound({ error: "Workflow not found" });
    }
    if (workflow.publishedVersionId !== expectedPublishedVersionId) {
      return yield* stalePublish();
    }
    if (workflow.draftRevision !== expectedDraftRevision) {
      return yield* new DraftConflict({
        error: "The workflow draft changed. Reload it before publishing again.",
        currentDraftRevision: workflow.draftRevision,
      });
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
      return yield* stalePublish();
    }
    if (current && semanticWorkflowGraphsEqual(current.graph, prepared.graph)) {
      return yield* new PublicationConflict({
        error: "This workflow graph is already published.",
        code: PUBLICATION_CONFLICT_CODES.alreadyPublished,
      });
    }

    const latest = yield* repo.findLatestVersion(workflowId);
    const expectedVersion = (latest?.version ?? 0) + 1;
    const published = yield* repo.insertPublishedVersion({
      workflowId,
      versionId: generateId(),
      version: expectedVersion,
      expectedPublishedVersionId,
      expectedDraftRevision,
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
      return yield* stalePublish();
    }
    if (published && "draftConflict" in published) {
      return yield* new DraftConflict({
        error: "The workflow draft changed. Reload it before publishing again.",
        currentDraftRevision: published.draftConflict,
      });
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
  // The span's verdict, from the answer rather than from each site that reached
  // it. A confirmed publish names the version it minted; a refusal the editor
  // recovers from names the code its recovery is chosen by, so a trace shows
  // which of the two ended the publish. Every other failure names no outcome.
  Effect.tap((payload) =>
    annotateServiceSpan({
      versionId: payload.publishedVersionId,
      versionNumber: payload.publishedVersion,
      outcome: "published",
    })
  ),
  Effect.tapError((failure) =>
    failure._tag === "PublicationConflict"
      ? annotateServiceSpan({ outcome: failure.code })
      : Effect.void
  ),
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
