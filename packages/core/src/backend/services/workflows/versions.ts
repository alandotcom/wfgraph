/**
 * Reads immutable publication versions, reports versions still in use, and
 * restores a publication into the editable draft. A restore never changes the
 * workflow's published pointer or its event index.
 */

import { Effect } from "effect";
import { uniq } from "es-toolkit/array";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { Extensions } from "#src/backend/lib/effect/extensions";
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
import {
  asPublishedVersion,
  WorkflowRepo,
  type WorkflowVersionUsageRow,
} from "#src/backend/services/workflows/repo";
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
  type WorkflowVersionUsageInput,
  type WorkflowVersionUsageItem,
  type WorkflowVersionUsagePayload,
} from "@wfgraph/shared/graph/publication-contracts";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import { enabledActionTypeOf } from "@wfgraph/shared/graph/node-config";
import { isBuiltInActionId } from "@wfgraph/shared/actions/built-in-actions";
import { isJsonObject } from "@wfgraph/shared/types/json";
import type { JsonValue } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { catalogFingerprint } from "#src/backend/services/workflows/version-digest";

const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow-versions").with({ workflowId })
  );

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
    if (
      current === undefined ||
      !isJsonObject(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return "[REDACTED]";
    }

    current = current[segment];
  }

  return current === undefined ? "[REDACTED]" : current;
}

function redactFieldChange(change: WorkflowFieldChange): WorkflowFieldChange {
  return omitUndefined({
    ...change,
    before:
      change.before === undefined
        ? undefined
        : redactFieldValue(change.path, change.before),
    after:
      change.after === undefined
        ? undefined
        : redactFieldValue(change.path, change.after),
  });
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

function versionUsageItem(
  row: WorkflowVersionUsageRow,
  availableActionIds: ReadonlySet<string>,
  liveCatalogFingerprint: string
): WorkflowVersionUsageItem {
  const actionIds = uniq(
    toWorkflowGraphData(row.graph).nodes.flatMap((node) => {
      const actionId = enabledActionTypeOf(node);
      return !actionId || isBuiltInActionId(actionId) ? [] : [actionId];
    })
  ).toSorted();

  const usage = {
    id: row.id,
    publishedAt: row.publishedAt.toISOString(),
    isCurrent: row.isCurrent,
    activeRunCount: row.activeRunCount,
    oldestActiveRunAt: row.oldestActiveRunAt?.toISOString() ?? null,
    actionIds,
    missingActionIds: actionIds.filter((id) => !availableActionIds.has(id)),
    catalogMatches: row.catalogFingerprint === liveCatalogFingerprint,
  };

  const versionIdentity =
    row.kind === "published"
      ? { kind: row.kind, version: row.version }
      : { kind: row.kind, version: row.version };
  return { ...usage, ...versionIdentity };
}

/** Reports the current publication and versions still pinned by active runs. */
export const getWorkflowVersionUsage = Effect.fn(
  "wfgraph.workflow.version.usage"
)(
  function* (input: WorkflowVersionUsageInput) {
    yield* annotateServiceSpan({ workflowId: input.workflowId });
    const repo = yield* WorkflowRepo;
    const extensions = yield* Extensions;
    const exists = yield* repo.existsById(input.workflowId);
    if (!exists) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    const availableActionIds = new Set(
      extensions.catalog.actions.map((action) => action.id)
    );
    const liveCatalogFingerprint = catalogFingerprint(extensions.catalog);
    const rows = yield* repo.listVersionUsage(input.workflowId);
    const payload: WorkflowVersionUsagePayload = {
      items: rows.map((row) =>
        versionUsageItem(row, availableActionIds, liveCatalogFingerprint)
      ),
    };
    return payload;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(input.workflowId),
          "Failed to get workflow version usage"
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
    // A draft snapshot sits outside the published history, so a comparison
    // against one fails the same way a version from another workflow does.
    const baseVersion = baseVersionId
      ? asPublishedVersion(yield* repo.findVersionById(baseVersionId))
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

    // A draft snapshot is reachable by id, because it is the execution
    // summary's `workflowVersionId`. It sits outside the published history, so
    // a restore refuses it the way the comparison above does.
    const version = asPublishedVersion(
      yield* repo.findVersionById(input.versionId)
    );
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
