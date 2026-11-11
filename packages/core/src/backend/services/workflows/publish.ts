/**
 * Publish mints an immutable workflow version from the editor graph, rewrites
 * the event subscription index and the cron timers from that graph, and points
 * the workflow at it.
 */

import { Clock, Effect } from "effect";
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
import type {
  WorkflowPublishInput,
  WorkflowPublishWarning,
} from "@wfgraph/shared/graph/publication-contracts";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import { isLifecycleNode } from "@wfgraph/shared/graph/node-config";
import { readLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { sumBy } from "es-toolkit/math";
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

/**
 * Whether a published graph's Lifecycle Rules track an Entity, which decides
 * the form its runs store their identity in. A graph with no rules starts
 * runs by hand, and those runs hold the untracked form. Null is a graph that
 * cannot be read.
 */
function tracksEntity(graph: SerializedWorkflowGraph): boolean | null {
  try {
    const entry = toWorkflowGraphData(graph).nodes.find(isLifecycleNode);
    const rules = readLifecycleRules(entry?.data.config);
    return rules?.trackedEntity !== undefined;
  } catch {
    return null;
  }
}

/**
 * The warnings a confirmed publish answers with. When the new version
 * identifies a run's Entity in another form than the version it replaced, the
 * runs every version in the old form still has in flight are counted, since
 * they finish on that version and Migration refuses them. A failed read costs
 * the warning and never the publish, which has already committed.
 */
const publishWarnings = Effect.fn("publishWarnings")(function* (input: {
  workflowId: string;
  replaced: SerializedWorkflowGraph | undefined;
  published: SerializedWorkflowGraph;
}) {
  const none: WorkflowPublishWarning[] = [];
  const tracksNow = tracksEntity(input.published);
  if (input.replaced === undefined || tracksNow === null) return none;
  if (tracksEntity(input.replaced) !== !tracksNow) return none;
  const repo = yield* WorkflowRepo;
  const usage = yield* repo.listVersionUsage(input.workflowId).pipe(
    Effect.tapError((error) =>
      Effect.flatMap(loggerFor(input.workflowId), (logger) =>
        logger.warn("Could not count runs for a publish warning", { error })
      )
    ),
    Effect.orElseSucceed(() => [])
  );
  const inFlightRuns = sumBy(
    usage.filter((row) => tracksEntity(row.graph) === !tracksNow),
    (row) => row.activeRunCount
  );
  if (inFlightRuns === 0) return none;
  return [
    {
      code: "entity_tracking_changed" as const,
      tracksEntity: tracksNow,
      inFlightRuns,
    },
  ];
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
      now: new Date(yield* Clock.currentTimeMillis),
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

    const warnings = yield* publishWarnings({
      workflowId,
      replaced: current?.graph,
      published: prepared.graph,
    });
    if (warnings.length > 0) {
      yield* logger.info("Published with warnings", {
        warnings: warnings.map((warning) => warning.code),
      });
    }

    const payload: WorkflowPublishPayload = {
      ...toWorkflowApiPayload(published.workflow, published.version),
      publishedVersionId: published.version.id,
      publishedVersion: published.version.version,
      publishedAt: published.version.publishedAt.toISOString(),
      warnings,
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
