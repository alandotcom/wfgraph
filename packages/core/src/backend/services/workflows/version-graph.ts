import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import { redactWorkflowGraph } from "#src/backend/lib/utils/redact";
import { WorkflowRepo } from "#src/backend/services/workflows/repo/index";

/** This module's logger, as the Effect that produces it (see `services/workflows/workflow.ts`). */
const loggerFor = (versionId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("version-graph").with({ versionId })
  );

/**
 * The pinned graph of one version a run froze, either a published version or a
 * draft snapshot. It has its own procedure because the graph is immutable once
 * minted (ADR-0012), so a client fetches it once per version id and caches the
 * answer forever. `getExecutionLogs` instead polls a run's status, and folding
 * the graph into that response would retransmit it on every tick.
 *
 * Redacted the same way a run's logged input and output are: a value an
 * author pasted into a node config must not leave the service verbatim.
 */
export const getVersionGraph = Effect.fn("getVersionGraph")(
  function* (versionId: string) {
    const repo = yield* WorkflowRepo;
    const logger = yield* loggerFor(versionId);

    const version = yield* repo.findVersionById(versionId);

    if (!version) {
      yield* logger.warn("Workflow version not found for graph");
      return yield* new NotFound({ error: "Workflow version not found" });
    }

    return { graph: redactWorkflowGraph(version.graph) };
  },
  (effect, versionId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(versionId),
          "Failed to get workflow version graph"
        )
      )
    )
);
