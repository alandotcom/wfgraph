/**
 * Reads immutable publication versions and restores one into the editable draft.
 * A restore never changes the workflow's published pointer or its event index.
 */

import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import { annotateServiceSpan } from "#src/backend/lib/telemetry";
import {
  redactSensitiveData,
  redactWorkflowGraph,
} from "#src/backend/lib/utils/redact";
import { diffWorkflowGraphs } from "#src/backend/services/workflows/graph-diff";
import { prepareGraphSave } from "#src/backend/services/workflows/graph-save";
import {
  buildWorkflowUpdateData,
  toWorkflowApiPayload,
} from "#src/backend/services/workflows/mappers";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { resolvePublishedVersion } from "#src/backend/services/workflows/workflow";
import {
  WORKFLOW_VERSION_HISTORY_DEFAULT_LIMIT,
  type WorkflowComparisonInput,
  type WorkflowComparisonPayload,
  type WorkflowFieldChange,
  type WorkflowRestoreVersionInput,
  type WorkflowVersionHistoryInput,
  type WorkflowVersionHistoryPayload,
  type WorkflowVersionCursor,
  type WorkflowVersionSummary,
} from "@wfgraph/shared/graph/publication-contracts";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { JsonObject, JsonValue } from "@wfgraph/shared/types/json";

const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow-versions").with({ workflowId })
  );

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function versionSummary(input: {
  id: string;
  version: number;
  publishedAt: Date;
  isCurrent: boolean;
}): WorkflowVersionSummary {
  return {
    id: input.id,
    version: input.version,
    publishedAt: input.publishedAt.toISOString(),
    isCurrent: input.isCurrent,
  };
}

function currentVersionSummary(
  input: {
    id: string;
    version: number;
    publishedAt: Date;
  },
  currentVersionId: string | null
): WorkflowVersionSummary {
  return versionSummary({
    ...input,
    isCurrent: input.id === currentVersionId,
  });
}

/** Redacts a value through its complete machine path so sensitive parents apply. */
function redactFieldValue(path: string[], value: JsonValue): JsonValue {
  if (path.length === 0) {
    return value;
  }

  let wrapped: JsonValue = value;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const segment = path[index];
    if (segment !== undefined) {
      wrapped = { [segment]: wrapped };
    }
  }

  let current = redactSensitiveData(wrapped);
  for (const segment of path) {
    if (!isJsonObject(current) || !Object.hasOwn(current, segment)) {
      return "[REDACTED]";
    }

    current = current[segment];
  }

  return current === undefined ? "[REDACTED]" : current;
}

function redactFieldChange(change: WorkflowFieldChange): WorkflowFieldChange {
  return {
    ...change,
    ...(change.before === undefined
      ? {}
      : { before: redactFieldValue(change.path, change.before) }),
    ...(change.after === undefined
      ? {}
      : { after: redactFieldValue(change.path, change.after) }),
  };
}

function versionNotFound(): NotFound {
  return new NotFound({ error: "Workflow version not found" });
}

/** Returns immutable versions newest first, with a cursor strictly before its version. */
export const getWorkflowVersionHistory = Effect.fn(
  "wfgraph.workflow.version.history"
)(
  function* (input: WorkflowVersionHistoryInput) {
    yield* annotateServiceSpan({ workflowId: input.workflowId });
    const repo = yield* WorkflowRepo;
    const limit = input.limit ?? WORKFLOW_VERSION_HISTORY_DEFAULT_LIMIT;
    const exists = yield* repo.existsById(input.workflowId);
    if (!exists) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    const rows = yield* repo.listVersionHistoryPage({
      workflowId: input.workflowId,
      limit,
      cursor: input.cursor,
    });
    const items = rows.slice(0, limit).map(versionSummary);
    const lastItem = rows.length > limit ? items.at(-1) : undefined;
    const nextCursor: WorkflowVersionCursor | null = lastItem
      ? { version: lastItem.version }
      : null;
    const payload: WorkflowVersionHistoryPayload = {
      items,
      nextCursor,
    };
    return payload;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(input.workflowId),
          "Failed to get workflow version history"
        )
      )
    )
);

/** Compares a historical graph with the exact draft supplied by the editor. */
export const compareWorkflowVersion = Effect.fn(
  "wfgraph.workflow.version.compare"
)(
  function* (input: WorkflowComparisonInput) {
    yield* annotateServiceSpan({ workflowId: input.workflowId });
    const repo = yield* WorkflowRepo;
    const logger = yield* loggerFor(input.workflowId);
    const workflow = yield* repo.findById(input.workflowId);
    if (!workflow) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    const baseVersionId = input.baseVersionId ?? workflow.publishedVersionId;
    const baseVersion = baseVersionId
      ? yield* repo.findVersionById(baseVersionId)
      : null;
    if (
      (baseVersionId && !baseVersion) ||
      (baseVersion && baseVersion.workflowId !== input.workflowId)
    ) {
      yield* logger.warn("Workflow version not found for comparison");
      return yield* versionNotFound();
    }

    // A comparison with no base reads against the empty graph; the helper drops
    // the key rather than recording an absent version as an empty attribute.
    yield* annotateServiceSpan({ baseVersionId: baseVersion?.id });

    const baseGraph = baseVersion
      ? (yield* prepareGraphSave({ graph: baseVersion.graph })).graph
      : createSerializedWorkflowGraph({ nodes: [], edges: [] });
    const draft = yield* prepareGraphSave({ graph: input.draftGraph });
    const latest = yield* repo.findLatestVersion(input.workflowId);
    const diff = diffWorkflowGraphs(baseGraph, draft.graph);
    const payload: WorkflowComparisonPayload = {
      baseVersion: baseVersion
        ? currentVersionSummary(baseVersion, workflow.publishedVersionId)
        : null,
      proposedVersion: (latest?.version ?? 0) + 1,
      baseGraph: redactWorkflowGraph(baseGraph),
      draftGraph: redactWorkflowGraph(draft.graph),
      hasChanges: diff.hasChanges,
      nodeChanges: diff.nodeChanges.map((node) => ({
        ...node,
        fields: node.fields.map(redactFieldChange),
      })),
      edgeChanges: diff.edgeChanges,
    };
    return payload;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(input.workflowId),
          "Failed to compare workflow versions"
        )
      )
    )
);

/** Copies a version graph to the draft while keeping the published version live. */
export const restoreWorkflowVersion = Effect.fn(
  "wfgraph.workflow.version.restore"
)(
  function* (input: WorkflowRestoreVersionInput) {
    yield* annotateServiceSpan({
      workflowId: input.workflowId,
      versionId: input.versionId,
    });
    const repo = yield* WorkflowRepo;
    const logger = yield* loggerFor(input.workflowId);
    const workflow = yield* repo.findById(input.workflowId);
    if (!workflow) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    const version = yield* repo.findVersionById(input.versionId);
    if (!version || version.workflowId !== input.workflowId) {
      yield* logger.warn("Workflow version not found for restore");
      return yield* versionNotFound();
    }

    const prepared = yield* prepareGraphSave({ graph: version.graph });
    const restored = yield* repo.update({
      workflowId: input.workflowId,
      updates: buildWorkflowUpdateData({ graph: prepared.graph }),
      eventSubscriptions: "unchanged",
    });
    if (!restored) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    const publishedVersion = yield* resolvePublishedVersion(
      repo,
      restored.publishedVersionId
    );
    return toWorkflowApiPayload(restored, publishedVersion);
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(input.workflowId),
          "Failed to restore workflow version"
        )
      )
    )
);
