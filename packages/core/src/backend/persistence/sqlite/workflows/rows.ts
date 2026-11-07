/**
 * Workflow and version rows read back from SQLite's text and integer columns
 * into the shapes `WorkflowRepo` answers, failing on a value no write here
 * stores.
 */

import type { Workflow, WorkflowVersion } from "#src/backend/lib/db/schema";
import type {
  workflowVersions,
  workflows,
} from "#src/backend/persistence/sqlite/schema";
import { isSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import {
  WORKFLOW_VERSION_KINDS,
  type WorkflowVersionKind,
} from "@wfgraph/shared/graph/version-kinds";

export function workflowMode(value: string): Workflow["mode"] {
  if (value !== "live" && value !== "test") {
    throw new Error("Invalid SQLite workflow mode");
  }
  return value;
}

export function workflowVisibility(value: string): Workflow["visibility"] {
  if (value !== "private" && value !== "public") {
    throw new Error("Invalid SQLite workflow visibility");
  }
  return value;
}

function workflowGraph(
  value: string,
  field = "graph"
): SerializedWorkflowGraph {
  const graph = JSON.parse(value);
  if (!isSerializedWorkflowGraph(graph)) {
    throw new Error(`Invalid SQLite ${field}`);
  }
  return graph;
}

export function workflowIsPaused(value: number): boolean {
  if (value !== 0 && value !== 1) {
    throw new Error("Invalid SQLite is_paused");
  }
  return value === 1;
}

function workflowVersionKind(value: string): WorkflowVersionKind {
  const kind = WORKFLOW_VERSION_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) throw new Error("Invalid SQLite kind");
  return kind;
}

export function sqliteWorkflow(row: typeof workflows.$inferSelect): Workflow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    graph: workflowGraph(row.graph),
    draftRevision: row.draftRevision,
    isPaused: workflowIsPaused(row.isPaused),
    mode: workflowMode(row.mode),
    visibility: workflowVisibility(row.visibility),
    publishedVersionId: row.publishedVersionId,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export function sqliteWorkflowVersion(
  row: typeof workflowVersions.$inferSelect
): WorkflowVersion {
  return {
    id: row.id,
    workflowId: row.workflowId,
    version: row.version,
    kind: workflowVersionKind(row.kind),
    graph: workflowGraph(row.graph),
    catalogFingerprint: row.catalogFingerprint,
    graphDigest: row.graphDigest,
    publishedAt: new Date(row.publishedAt),
    lastPinnedAt: row.lastPinnedAt === null ? null : new Date(row.lastPinnedAt),
  };
}
