/**
 * The engine input for one run of a persisted Execution, read from the
 * execution row, its workflow, and the Workflow Version the row pins at the
 * moment of the read. The executor loads it at the start of every pass, so a
 * body always walks the version a Migration last pinned. A run that cannot be
 * loaded answers `RunInputUnavailable`, which no retry can mend. A caller that
 * loads many passes hands in a `RunVersionCache`, so each version is read once.
 */

import { Effect, Schema } from "effect";
import type { WorkflowExecutionInput } from "#src/backend/engine/core";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { ExecutionSummary } from "#src/backend/services/executions/repo/contracts";
import type { WorkflowVersion } from "#src/backend/lib/db/schema";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";

/**
 * Why a run could not be loaded: the execution row is gone, it is no longer in
 * flight, or the version it pins is missing or belongs to another workflow.
 */
export class RunInputUnavailable extends Schema.TaggedError<
  RunInputUnavailable,
  { readonly brand: unique symbol }
>()("RunInputUnavailable", {
  reason: Schema.Literals([
    "missing_execution",
    "not_in_flight",
    "missing_version",
  ]),
  message: Schema.String,
}) {}

function isInFlightStatus(status: ExecutionSummary["status"]): boolean {
  return IN_FLIGHT_EXECUTION_STATUSES.some((inFlight) => inFlight === status);
}

/** The fields of a Workflow Version a run's input is built from. */
type RunVersion = Pick<
  WorkflowVersion,
  "id" | "workflowId" | "graph" | "catalogFingerprint"
>;

/** How many versions a `RunVersionCache` holds before it drops the oldest. */
const RUN_VERSION_CACHE_LIMIT = 256;

/**
 * The Workflow Versions recent passes ran, by version id, so the next pass of
 * a run on the same version skips the read and the graph decode. A version row
 * is never updated once written, so a held entry never goes stale. A version a
 * run pins is deleted only with its workflow or its execution, and the load
 * reads both rows on every pass, so a deleted version is never served. It holds
 * at most `limit` versions and drops the one used longest ago, and it belongs
 * to one database, so each worker loop makes its own.
 */
export type RunVersionCache = {
  readonly get: (versionId: string) => RunVersion | undefined;
  readonly set: (version: RunVersion) => void;
};

export function createRunVersionCache(
  limit: number = RUN_VERSION_CACHE_LIMIT
): RunVersionCache {
  // A Map iterates in insertion order, so re-inserting an entry on every use
  // keeps the entry used longest ago first.
  const versions = new Map<string, RunVersion>();
  return {
    get: (versionId) => {
      const version = versions.get(versionId);
      if (version === undefined) return undefined;
      versions.delete(versionId);
      versions.set(versionId, version);
      return version;
    },
    set: (version) => {
      versions.delete(version.id);
      versions.set(version.id, version);
      if (versions.size <= limit) return;
      const oldest = versions.keys().next();
      if (oldest.done !== true) versions.delete(oldest.value);
    },
  };
}

/** The version from `cache` when it holds it, otherwise read and kept there. */
function findRunVersion(
  workflows: WorkflowRepo["Service"],
  versionId: string,
  cache: RunVersionCache | undefined
): Effect.Effect<RunVersion | null, DatabaseError> {
  const cached = cache?.get(versionId);
  if (cached !== undefined) return Effect.succeed(cached);
  return workflows.findVersionById(versionId).pipe(
    Effect.tap((version) =>
      Effect.sync(() => {
        if (version !== null) cache?.set(version);
      })
    )
  );
}

export function loadPersistedRunInput(
  executionId: string,
  options?: { versions?: RunVersionCache | undefined }
): Effect.Effect<
  WorkflowExecutionInput,
  RunInputUnavailable | DatabaseError,
  ExecutionRepo | WorkflowRepo
> {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const workflows = yield* WorkflowRepo;
    const execution = yield* executions.findSummaryById(executionId);
    if (!execution) {
      return yield* new RunInputUnavailable({
        reason: "missing_execution",
        message: "The requested workflow execution does not exist",
      });
    }
    if (!isInFlightStatus(execution.status)) {
      return yield* new RunInputUnavailable({
        reason: "not_in_flight",
        message: "The requested workflow execution is no longer in flight",
      });
    }

    const [workflow, version] = yield* Effect.all([
      workflows.findById(execution.workflowId),
      findRunVersion(workflows, execution.workflowVersionId, options?.versions),
    ]);
    if (!workflow || !version || version.workflowId !== execution.workflowId) {
      return yield* new RunInputUnavailable({
        reason: "missing_version",
        message: "The requested workflow version does not exist",
      });
    }

    return {
      graph: version.graph,
      workflowVersionId: version.id,
      catalogFingerprint: version.catalogFingerprint,
      startPayload: execution.input ?? {},
      requestPayload: execution.input ?? {},
      startEventName: execution.startEventName ?? undefined,
      executionId: execution.id,
      workflowId: execution.workflowId,
      workflowName: workflow.name,
      entityType: execution.entityType ?? undefined,
      entityId: execution.entityId ?? undefined,
      runMode: execution.runMode,
    };
  });
}
