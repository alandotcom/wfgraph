import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import { redactWorkflowGraph } from "#src/backend/lib/utils/redact";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";

/** This module's logger, as the Effect that produces it (see `services/workflows/workflow.ts`). */
const loggerFor = (versionId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "version-graph").with({ versionId })
  );

/**
 * The pinned graph of one published version, on its own procedure: the graph
 * is immutable once minted (ADR-0012), so a client fetches this once per
 * version id and caches the answer forever, unlike `getExecutionLogs`, which
 * polls a run's status and would otherwise retransmit the same graph on every
 * tick.
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
        internalFailureRelayingCause(
          loggerFor(versionId),
          "Failed to get workflow version graph"
        )
      )
    )
);
