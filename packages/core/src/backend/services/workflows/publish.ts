/**
 * Publish: mint (or reuse) an immutable workflow version from the editor graph,
 * rewrite the event subscription index from that graph, and point the workflow
 * at it so starts use it.
 *
 * The version sweep at the end runs after that write has committed, so it is
 * awaited but cannot fail the publish: its failure is a warning and nothing
 * more.
 */

import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { Extensions } from "#src/backend/lib/effect/extensions";
import {
  Conflict,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { prepareGraphSave } from "#src/backend/services/workflows/graph-save";
import { toWorkflowApiPayload } from "#src/backend/services/workflows/mappers";
import type { WorkflowPublishPayload } from "@wfgraph/shared/graph/api-contracts";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import { checkUnreachableSubtrees } from "#src/backend/services/workflows/publish-checks";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  catalogFingerprint,
  graphDigest,
} from "#src/backend/services/workflows/version-digest";
import { generateId } from "@wfgraph/shared/utils/id";
import { getErrorMessage } from "@wfgraph/shared/utils";

const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("publish").with({ workflowId })
  );

const publishOnlyChecks = [checkUnreachableSubtrees] as const;

const STALE_PUBLISH_MESSAGE =
  "This workflow was published elsewhere. Refresh and try again.";

/**
 * Versions a workflow keeps whatever their state.
 *
 * Nothing in the product reads an unreferenced version — the run panel fetches
 * the graph by the id its Execution pins, and a version an Execution pins is
 * never swept — so this is a margin around the head of the list rather than a
 * retention guarantee anyone reads.
 */
export const RETAINED_VERSIONS_PER_WORKFLOW = 10;

/** Versions one publish sweeps, so a long backlog drains over several. */
const VERSION_PRUNE_BATCH = 50;

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
          expectedPublishedVersionId: workflow.publishedVersionId,
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

    if (published && "stale" in published) {
      yield* logger.warn("Rejected workflow publish: published version race");
      return yield* new Conflict({ error: STALE_PUBLISH_MESSAGE });
    }

    if (!published) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    yield* logger.info(
      matching
        ? "Workflow publish reused existing version"
        : "Workflow published",
      {
        version: {
          id: published.version.id,
          number: published.version.version,
          ...(matching ? {} : { nodes: prepared.nodes.length }),
        },
      }
    );

    // Publish is the only event that grows the version table, so bounding it
    // here holds the bound continuously. The reuse path sweeps too: the version
    // the workflow pointed at a moment ago is the one that just became
    // unreferenced. The write above has committed, so a failure here is a
    // warning rather than a 500 for a publish that happened.
    const pruned = yield* repo
      .pruneUnreferencedVersions({
        workflowId,
        keepNewest: RETAINED_VERSIONS_PER_WORKFLOW,
        limit: VERSION_PRUNE_BATCH,
      })
      .pipe(
        Effect.catchTag("DatabaseError", (failure) =>
          logger
            .warn("Failed to prune unreferenced workflow versions", {
              error: getErrorMessage(failure.cause),
            })
            .pipe(Effect.as<string[]>([]))
        )
      );
    if (pruned.length > 0) {
      yield* logger.info("Pruned unreferenced workflow versions", {
        count: pruned.length,
        versionIds: pruned,
      });
    }

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
        internalFailureFromCause(
          loggerFor(input.workflowId),
          "Failed to publish workflow"
        )
      )
    )
);
