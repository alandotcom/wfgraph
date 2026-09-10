/**
 * Decides, for each in-flight run, whether the target version can take it over.
 *
 * A run qualifies while it is parked on a Wait node the target graph still has,
 * with a timeout that has not already passed, and every template below that Wait
 * names a node the run either reaches after waking or has already recorded an
 * output for. Both the preview and the migrate call read their verdicts from
 * here.
 */

import { Effect } from "effect";
import { chunk } from "es-toolkit/array";
import { descendantsOf } from "@wfgraph/shared/graph/descendants";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import {
  enabledActionTypeOf,
  isWaitActionType,
} from "@wfgraph/shared/graph/node-config";
import { extractAllTemplateReferences } from "@wfgraph/shared/graph/node-references";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import type { MigrationRefusalReason } from "@wfgraph/shared/graph/migration-contracts";
import { DEFAULT_WAIT_TIMEOUT } from "@wfgraph/shared/lifecycle/wait-subscription";
import { parseDurationMs } from "@wfgraph/shared/utils/wait-time";
import type { PublishedWorkflowVersion } from "#src/backend/lib/db/schema";
import {
  ExecutionRepo,
  type InFlightExecutionRow,
  type WorkflowWaitState,
} from "#src/backend/services/executions/repo";

/**
 * How many runs' outputs are read at once.
 *
 * Only a run whose target graph holds a template the graph alone cannot answer
 * costs a read, so this bounds the tail of a large workflow rather than the
 * common case.
 */
const NODE_OUTPUT_READ_CONCURRENCY = 8;

/**
 * How many run ids one parked-wait read is given.
 *
 * The read expands to an `IN` list, and both engines have a bound on how long
 * one statement's parameter list may be.
 */
const WAIT_LOOKUP_CHUNK_SIZE = 500;

export type MigrationClassification =
  /** Already pinned to the target version, so there is nothing to move. */
  | { kind: "already_current"; candidate: InFlightExecutionRow }
  | {
      kind: "eligible";
      candidate: InFlightExecutionRow;
      /** The rows to signal, each carrying the token its park is addressed by. */
      waitStates: WorkflowWaitState[];
    }
  | {
      kind: "refused";
      candidate: InFlightExecutionRow;
      reason: MigrationRefusalReason;
      detail?: string | undefined;
    };

/** One template reference the target graph alone cannot answer. */
type PendingReference = {
  /** The node whose config holds the reference. */
  nodeId: string;
  /** The dotted config key the reference was written into. */
  field: string;
  /** The node the reference names. */
  referencedNodeId: string;
};

/**
 * What one enabled Wait node of the target graph contributes to a verdict.
 *
 * `reach` is the Wait node and everything below it: the nodes a run parked here
 * still runs, so a reference into any of them resolves as the run continues.
 * `references` is every template reference written in those nodes, unfiltered,
 * because which of them resolve depends on the run: a run parked at two Waits
 * reaches the union of both sets.
 */
type WaitNodeScan = {
  reach: Set<string>;
  references: PendingReference[];
  /** The node's own timeout, in milliseconds, for a run parked on an Event. */
  timeoutMs: number | null;
};

function scanWaitNode(input: {
  waitNode: WorkflowNode;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): WaitNodeScan {
  const reach = descendantsOf({
    startIds: [input.waitNode.id],
    edges: input.edges,
  });
  reach.add(input.waitNode.id);

  // The Wait node's own config is scanned beside the nodes below it, because
  // the migrated hop resolves that config again: its `waitFor` matches, its
  // `waitUntil` and its `waitDuration` are all templates the run must answer.
  const references = input.nodes.flatMap((node) =>
    reach.has(node.id) && node.data.enabled !== false && node.data.config
      ? extractAllTemplateReferences(node.data.config).map((reference) => ({
          nodeId: node.id,
          field: reference.field,
          referencedNodeId: reference.nodeId,
        }))
      : []
  );

  const timeout = input.waitNode.data.config?.waitTimeout;
  return {
    reach,
    references,
    timeoutMs: parseDurationMs(
      typeof timeout === "string" && timeout.trim()
        ? timeout
        : DEFAULT_WAIT_TIMEOUT
    ),
  };
}

/** Every enabled Wait node of the target graph, scanned once for the whole set. */
function scanWaitNodes(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[]
): Map<string, WaitNodeScan> {
  return new Map(
    nodes
      .filter((node) => isWaitActionType(enabledActionTypeOf(node)))
      .map((waitNode) => [
        waitNode.id,
        scanWaitNode({ waitNode, nodes, edges }),
      ])
  );
}

/** The parked wait rows of every candidate, read in bounded batches. */
const listParkedWaits = Effect.fn("listParkedWaits")(function* (
  executionIds: string[]
) {
  const repo = yield* ExecutionRepo;
  const pages = yield* Effect.forEach(
    chunk(executionIds, WAIT_LOOKUP_CHUNK_SIZE),
    (ids) => repo.listWaitingStatesForExecutions(ids)
  );

  return new Map(pages.flatMap((page) => [...page]));
});

/**
 * Whether a run parked on this Event wait would time out the moment it woke.
 *
 * The park instant is the row's own `createdAt`, and the timeout is the target
 * graph's, because that is the pair the migrated hop is computed from. A run
 * refused here would, under `waitTimeoutBehavior: "skip"`, halt its branch
 * rather than continue on the newer graph. A delay wait is never refused for
 * this: a target already in the past resumes at once, which is a legitimate
 * reason to migrate.
 */
function waitTimeoutHasElapsed(input: {
  waitState: WorkflowWaitState;
  timeoutMs: number | null;
  now: number;
}): boolean {
  return (
    input.waitState.waitType === "event" &&
    input.timeoutMs !== null &&
    input.waitState.createdAt.getTime() + input.timeoutMs <= input.now
  );
}

const classifyOne = Effect.fn("classifyOne")(function* (input: {
  candidate: InFlightExecutionRow;
  waitStates: WorkflowWaitState[];
  waitNodes: Map<string, WaitNodeScan>;
  targetVersion: PublishedWorkflowVersion;
  now: number;
}) {
  const { candidate, waitStates, waitNodes } = input;
  const refuse = (
    reason: MigrationRefusalReason,
    detail?: string
  ): MigrationClassification => ({
    kind: "refused",
    candidate,
    reason,
    detail,
  });

  if (candidate.versionKind === "draft_snapshot") {
    return refuse("draft_run");
  }

  if (candidate.workflowVersionId === input.targetVersion.id) {
    return {
      kind: "already_current",
      candidate,
    } satisfies MigrationClassification;
  }

  if (candidate.status !== "waiting" || waitStates.length === 0) {
    return refuse("executing");
  }

  const scans = waitStates.map((waitState) => ({
    waitState,
    scan: waitNodes.get(waitState.nodeId),
  }));

  const missing = scans.find((entry) => !entry.scan);
  if (missing) {
    return refuse("wait_node_missing", missing.waitState.nodeId);
  }

  const elapsed = scans.find((entry) =>
    waitTimeoutHasElapsed({
      waitState: entry.waitState,
      timeoutMs: entry.scan?.timeoutMs ?? null,
      now: input.now,
    })
  );
  if (elapsed) {
    return refuse("wait_timeout_elapsed", elapsed.waitState.nodeId);
  }

  // A run parked at several Waits still runs everything below any of them, so
  // a reference below one Wait that names a node below another resolves.
  const reachable = new Set(
    scans.flatMap((entry) => [...(entry.scan?.reach ?? [])])
  );
  const pending = scans
    .flatMap((entry) => entry.scan?.references ?? [])
    .filter((reference) => !reachable.has(reference.referencedNodeId));

  if (pending.length > 0) {
    const repo = yield* ExecutionRepo;
    const recorded = new Set(
      Object.keys(yield* repo.readNodeOutputs(candidate.id))
    );
    const unresolved = pending.find(
      (reference) => !recorded.has(reference.referencedNodeId)
    );
    if (unresolved) {
      return refuse(
        "unresolved_reference",
        `${unresolved.nodeId}.${unresolved.field}`
      );
    }
  }

  return {
    kind: "eligible",
    candidate,
    waitStates,
  } satisfies MigrationClassification;
});

/**
 * Classifies each candidate against the target version, reading the parked wait
 * rows once for the whole set and one run's outputs only when a template it
 * would run needs them.
 */
export const classifyMigrationCandidates = Effect.fn(
  "classifyMigrationCandidates"
)(function* (input: {
  candidates: readonly InFlightExecutionRow[];
  targetVersion: PublishedWorkflowVersion;
}) {
  const graph = toWorkflowGraphData(input.targetVersion.graph);
  const waitNodes = scanWaitNodes(graph.nodes, graph.edges);
  const waitsByExecution = yield* listParkedWaits(
    input.candidates.map((candidate) => candidate.id)
  );
  const now = Date.now();

  return yield* Effect.forEach(
    input.candidates,
    (candidate) =>
      classifyOne({
        candidate,
        waitStates: waitsByExecution.get(candidate.id) ?? [],
        waitNodes,
        targetVersion: input.targetVersion,
        now,
      }),
    { concurrency: NODE_OUTPUT_READ_CONCURRENCY }
  );
});
