/**
 * Decides, for each in-flight run, whether the target version can take it over.
 *
 * A run qualifies while it is parked on Wait nodes the target graph still has,
 * none of which the target graph places below another, whose timeout has not
 * already passed when that target Wait waits for an Event, no enabled node
 * outside the parked Waits' descendant sets is new to the run, and every
 * template below a Wait resolves from a recorded output or from a node upstream
 * of its consumer. Both the preview and the migrate call read their verdicts
 * from here.
 */

import { Effect } from "effect";
import { chunk } from "es-toolkit/array";
import { descendantsOf } from "@wfgraph/shared/graph/descendants";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import {
  enabledActionTypeOf,
  isLifecycleNode,
  isWaitActionType,
} from "@wfgraph/shared/graph/node-config";
import { upstreamNodeIds } from "@wfgraph/shared/graph/upstream-nodes";
import {
  extractAllTemplateReferences,
  findTemplateTokens,
  resolveOutputPath,
  type TemplateToken,
} from "@wfgraph/shared/graph/node-references";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import type { MigrationRefusalReason } from "@wfgraph/shared/graph/migration-contracts";
import { DEFAULT_WAIT_TIMEOUT } from "@wfgraph/shared/lifecycle/wait-subscription";
import {
  type JsonValue,
  readJsonObjectLeniently,
} from "@wfgraph/shared/types/json";
import { decodeIsoTimestamp } from "@wfgraph/shared/types/timestamp";
import { parseDurationMs } from "@wfgraph/shared/utils/wait-time";
import type { PublishedWorkflowVersion } from "#src/backend/lib/db/schema";
import {
  type NodeOutputs,
  wrapStoredOutput,
} from "#src/backend/engine/contracts";
import { resolveTemplateString } from "#src/backend/engine/templates";
import {
  ExecutionRepo,
  type InFlightExecutionRow,
  type WorkflowWaitState,
} from "#src/backend/services/executions/repo";

/**
 * How many runs' outputs are read at once.
 *
 * Only a run whose target graph holds a template the graph alone cannot answer,
 * in a node below a parked Wait or in a parked Wait's own timeout, costs a read.
 * This therefore bounds the tail of a large workflow rather than the common
 * case.
 */
const NODE_OUTPUT_READ_CONCURRENCY = 8;

/**
 * How many run ids one batched read is given.
 *
 * A batched read expands to an `IN` list, and both engines have a bound on how
 * long one statement's parameter list may be. The parked wait rows and the
 * logged node ids are both read this way.
 */
const EXECUTION_LOOKUP_CHUNK_SIZE = 500;

export type MigrationClassification =
  /**
   * Already pinned to the target version, so the pointer has nothing to move.
   * The rows the run is parked on come along, because a migrate call wakes them
   * for a run repinned by an earlier call whose signal never went out.
   */
  | {
      kind: "already_current";
      candidate: InFlightExecutionRow;
      waitStates: WorkflowWaitState[];
    }
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
  /** The dotted path into that node's output; empty when the token names the whole output. */
  referencedFieldPath: string;
};

/**
 * What one enabled Wait node of the target graph contributes to a verdict.
 *
 * `reach` is the Wait node and everything below it: the nodes a run parked here
 * still runs. `references` is every template reference written in those nodes.
 * A reference resolves from graph order only when its source is upstream of its
 * consumer.
 */
type WaitNodeScan = {
  reach: Set<string>;
  references: PendingReference[];
  /**
   * The node's authored timeout, or null when it does not wait for an Event.
   *
   * `waitTimeout` is a config value like every other, so it can hold template
   * tokens and resolve to a different duration in each run. The milliseconds are
   * therefore a per-run answer, and `tokens` is what says whether a run's
   * recorded outputs have to be read to reach it.
   */
  eventTimeout: { template: string; tokens: TemplateToken[] } | null;
};

/** One parked wait row of a run, beside the target Wait node it lands on. */
type ParkedWait = {
  waitState: WorkflowWaitState;
  scan: WaitNodeScan;
};

/**
 * Every template reference written into one node's config.
 *
 * A config is JSON. Reading it back as JSON drops a key the editor cleared and
 * leaves every template beside it in the walk.
 */
function referencesOf(node: WorkflowNode): PendingReference[] {
  const config = readJsonObjectLeniently(node.data.config);

  return config === null
    ? []
    : extractAllTemplateReferences(config).map((reference) => ({
        nodeId: node.id,
        field: reference.field,
        referencedNodeId: reference.nodeId,
        referencedFieldPath: reference.fieldPath,
      }));
}

function scanWaitNode(input: {
  waitNode: WorkflowNode;
  referencesByNode: Map<string, PendingReference[]>;
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
  const references = [...reach].flatMap(
    (nodeId) => input.referencesByNode.get(nodeId) ?? []
  );

  const config = input.waitNode.data.config;
  const timeout = config?.waitTimeout;
  // Absence reads as the selector's delay default, the same way the editor and
  // the engine read this key.
  const template =
    typeof timeout === "string" && timeout.trim()
      ? timeout
      : DEFAULT_WAIT_TIMEOUT;

  return {
    reach,
    references,
    eventTimeout:
      config?.waitMode === "event"
        ? { template, tokens: findTemplateTokens(template) }
        : null,
  };
}

/**
 * Every enabled Wait node of the target graph, scanned once for the whole set.
 *
 * Each enabled node's templates are extracted once here and read by every Wait
 * whose reach holds that node, so a graph with several Waits walks each config
 * one time.
 */
function scanWaitNodes(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[]
): Map<string, WaitNodeScan> {
  const referencesByNode = new Map(
    nodes
      .filter((node) => node.data.enabled !== false)
      .map((node) => [node.id, referencesOf(node)] as const)
  );

  return new Map(
    nodes
      .filter((node) => isWaitActionType(enabledActionTypeOf(node)))
      .map((waitNode) => [
        waitNode.id,
        scanWaitNode({ waitNode, referencesByNode, edges }),
      ])
  );
}

/** The parked wait rows of every candidate, read in bounded batches. */
const listParkedWaits = Effect.fn("listParkedWaits")(function* (
  executionIds: string[]
) {
  const repo = yield* ExecutionRepo;
  const pages = yield* Effect.forEach(
    chunk(executionIds, EXECUTION_LOOKUP_CHUNK_SIZE),
    (ids) => repo.listWaitingStatesForExecutions(ids)
  );

  return new Map(pages.flatMap((page) => [...page]));
});

/**
 * The node ids every candidate has a run-log row for, read in bounded batches.
 *
 * A run with no rows is absent from the map the repository answers with, and a
 * run absent here reads as having produced nothing.
 */
const listLoggedNodeIds = Effect.fn("listLoggedNodeIds")(function* (
  executionIds: string[]
) {
  const repo = yield* ExecutionRepo;
  const pages = yield* Effect.forEach(
    chunk(executionIds, EXECUTION_LOOKUP_CHUNK_SIZE),
    (ids) => repo.listLoggedNodeIdsForExecutions(ids)
  );

  return new Map(pages.flatMap((page) => [...page]));
});

/**
 * Pairs each parked wait row with the target Wait node it lands on, or names the
 * first row whose node the target graph holds no enabled Wait for.
 */
function pairParkedWaits(
  waitStates: readonly WorkflowWaitState[],
  waitNodes: Map<string, WaitNodeScan>
): { parked: ParkedWait[] } | { missingNodeId: string } {
  const parked: ParkedWait[] = [];
  for (const waitState of waitStates) {
    const scan = waitNodes.get(waitState.nodeId);
    if (!scan) {
      return { missingNodeId: waitState.nodeId };
    }
    parked.push({ waitState, scan });
  }

  return { parked };
}

/**
 * The parked Wait the target graph places another parked Wait below, if there is
 * one.
 *
 * Each parked Wait wakes a branch run of its own. A branch entered at the upper
 * Wait runs down to the lower Wait and parks a second time on the row the other
 * branch already holds, so the two branches then race for the same row. The id
 * answered is the upper Wait's.
 */
function nestedWaitNodeId(parked: readonly ParkedWait[]): string | undefined {
  const parkedNodeIds = new Set(parked.map((entry) => entry.waitState.nodeId));

  return parked.find((entry) =>
    [...entry.scan.reach].some(
      (nodeId) => nodeId !== entry.waitState.nodeId && parkedNodeIds.has(nodeId)
    )
  )?.waitState.nodeId;
}

/**
 * The run's recorded outputs, in the shape the engine's template resolver reads.
 *
 * A stored row holds a step's own payload while the traversal holds the
 * `{ success, data }` envelope around it, so each row is wrapped again here and
 * a path resolves to the value it would resolve to during the run. The label is
 * carried by the token rather than read from here, so the node id stands in for
 * it.
 */
function toNodeOutputs(recorded: Record<string, JsonValue>): NodeOutputs {
  // oxlint-disable-next-line wfgraph/no-entries-round-trip -- the keys are node ids read back out of stored JSON, so one of them can be an own __proto__ key. mapValues assigns result[key] = value, which would reach the prototype setter and lose the output.
  return Object.fromEntries(
    Object.entries(recorded).map(([nodeId, data]) => [
      nodeId,
      { label: nodeId, data: wrapStoredOutput(data) },
    ])
  );
}

/**
 * Whether the recorded outputs answer this path the way the engine would.
 *
 * A node id on its own is not enough: `{{@lookup:Lookup.customerId}}` renders as
 * empty text when the run recorded an output for `lookup` that carries no
 * `customerId`. The path is walked with the walker the engine's template
 * resolution uses, so a path that resolves here resolves there.
 *
 * A path that reaches a stored `null` resolves: the builder gets the null the
 * node produced, which is a value the run recorded rather than a missing one.
 */
function outputPathResolves(
  input: { nodeId: string; fieldPath: string },
  outputs: NodeOutputs
): boolean {
  const output = outputs[input.nodeId];

  return (
    output !== undefined &&
    resolveOutputPath(output.data, input.fieldPath) !== undefined
  );
}

/** The same question for a reference found in a node's config. */
function referenceResolves(
  reference: PendingReference,
  outputs: NodeOutputs
): boolean {
  return outputPathResolves(
    {
      nodeId: reference.referencedNodeId,
      fieldPath: reference.referencedFieldPath,
    },
    outputs
  );
}

/**
 * The instant a parked row's timeout is measured from.
 *
 * The first park writes the instant it resolved against onto the row's
 * metadata as `anchorAt`, and every recompute of that Wait resolves durations
 * and targets from it. A row written before that key existed carries none, and
 * the row's own `createdAt` is the instant it was opened at.
 */
function parkAnchorMs(waitState: WorkflowWaitState): number {
  const anchorAt = waitState.metadata?.anchorAt;
  const anchor =
    typeof anchorAt === "string" ? decodeIsoTimestamp(anchorAt) : null;

  return (anchor ?? waitState.createdAt).getTime();
}

/**
 * Whether the migrated hop would time out the moment it woke.
 *
 * The park instant is the row's anchor, and both the timeout and the
 * shape are the target Wait's, because that is what the migrated hop is
 * computed from: a run that parked on a delay and lands on an Event Wait waits
 * for that Event under the target's timeout. The timeout is resolved against
 * this run's own recorded outputs with the resolver the engine uses, so two runs
 * reaching the same template with different outputs get the two durations they
 * would park under. A run refused here would, under
 * `waitTimeoutBehavior: "skip"`, halt its branch rather than continue on the
 * newer graph.
 *
 * A target Wait in delay mode is never refused for this: it has no Event to
 * miss, and a delay target already in the past resumes at once, which is a
 * legitimate reason to migrate. A timeout whose resolved text is no duration is
 * not refused either, because the hop parks on the engine's own fallback.
 *
 * Every token in the timeout has been checked against the recorded outputs
 * before this runs, so the resolved text holds no unanswered token.
 */
function waitTimeoutElapsed(input: {
  parked: ParkedWait;
  outputs: NodeOutputs;
  now: number;
}): boolean {
  const eventTimeout = input.parked.scan.eventTimeout;
  if (eventTimeout === null) {
    return false;
  }

  const timeoutMs = parseDurationMs(
    resolveTemplateString(eventTimeout.template, input.outputs)
  );

  return (
    timeoutMs !== null &&
    parkAnchorMs(input.parked.waitState) + timeoutMs <= input.now
  );
}

/**
 * The timeout tokens of one parked row, as references named by the field they
 * were written into.
 *
 * The elapsed check needs a duration, so a token here is answered from the
 * recorded outputs whether or not the node it names is upstream of the Wait.
 */
function timeoutReferences(parked: ParkedWait): PendingReference[] {
  return (parked.scan.eventTimeout?.tokens ?? []).map((token) => ({
    nodeId: parked.waitState.nodeId,
    field: "waitTimeout",
    referencedNodeId: token.nodeId,
    referencedFieldPath: token.fieldPath,
  }));
}

const classifyOne = Effect.fn("classifyOne")(function* (input: {
  candidate: InFlightExecutionRow;
  waitStates: WorkflowWaitState[];
  waitNodes: Map<string, WaitNodeScan>;
  /** The target nodes a run has to hold a node log row for, unless a parked Wait reaches them. */
  checkedNodes: readonly WorkflowNode[];
  /** The node ids this run has a run-log row for, empty when no node is checked. */
  loggedNodeIds: Set<string>;
  targetEdges: readonly WorkflowEdge[];
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
      waitStates,
    } satisfies MigrationClassification;
  }

  if (candidate.status !== "waiting" || waitStates.length === 0) {
    return refuse("executing");
  }

  const paired = pairParkedWaits(waitStates, waitNodes);
  if ("missingNodeId" in paired) {
    return refuse("wait_node_missing", paired.missingNodeId);
  }
  const { parked } = paired;

  const nested = nestedWaitNodeId(parked);
  if (nested) {
    return refuse("waits_nested", nested);
  }

  // Every reference the target graph alone cannot answer, in one list: the
  // parked Waits' own timeout tokens first, then the templates below them that
  // graph order does not already cover.
  const pending = [
    ...parked.flatMap(timeoutReferences),
    ...parked
      .flatMap((entry) => entry.scan.references)
      .filter(
        (reference) =>
          !upstreamNodeIds(reference.nodeId, input.targetEdges).has(
            reference.referencedNodeId
          )
      ),
  ];

  // One read answers the whole list, and a run whose target graph asks nothing
  // of the recorded outputs costs no read at all.
  const repo = yield* ExecutionRepo;
  const outputs = toNodeOutputs(
    pending.length > 0 ? yield* repo.readNodeOutputs(candidate.id) : {}
  );

  const unresolved = pending.find(
    (reference) => !referenceResolves(reference, outputs)
  );
  if (unresolved) {
    return refuse(
      "unresolved_reference",
      `${unresolved.nodeId}.${unresolved.field}`
    );
  }

  const elapsed = parked.find((entry) =>
    waitTimeoutElapsed({ parked: entry, outputs, now: input.now })
  );
  if (elapsed) {
    return refuse("wait_timeout_elapsed", elapsed.waitState.nodeId);
  }

  // Only a node the target graph places outside every parked Wait's reach can
  // be new to this run, so a target whose reach covers the graph asks the node
  // log nothing.
  const reachable = new Set(parked.flatMap((entry) => [...entry.scan.reach]));
  const addedAboveWait = input.checkedNodes.find(
    (node) => !reachable.has(node.id) && !input.loggedNodeIds.has(node.id)
  );
  if (addedAboveWait) {
    return refuse("node_added_above_wait", addedAboveWait.id);
  }

  return {
    kind: "eligible",
    candidate,
    waitStates,
  } satisfies MigrationClassification;
});

/**
 * Classifies each candidate against the target version, reading the parked wait
 * rows once for the whole set, the logged node ids once for the whole set when
 * the target graph holds a node a run could be missing, and one run's outputs
 * only when a template it would run needs them.
 */
export const classifyMigrationCandidates = Effect.fn(
  "classifyMigrationCandidates"
)(function* (input: {
  candidates: readonly InFlightExecutionRow[];
  targetVersion: PublishedWorkflowVersion;
}) {
  const graph = toWorkflowGraphData(input.targetVersion.graph);
  const waitNodes = scanWaitNodes(graph.nodes, graph.edges);
  // A disabled node never runs, and the Lifecycle node is the run's entry
  // rather than work a target version adds, so neither can be a node this run
  // is missing.
  const checkedNodes = graph.nodes.filter(
    (node) => node.data.enabled !== false && !isLifecycleNode(node)
  );
  const executionIds = input.candidates.map((candidate) => candidate.id);
  const waitsByExecution = yield* listParkedWaits(executionIds);
  // A target graph whose Waits reach every node has nothing to compare a run
  // log against, so the whole set is spared the read.
  const loggedByExecution =
    checkedNodes.length > 0
      ? yield* listLoggedNodeIds(executionIds)
      : new Map<string, Set<string>>();
  const now = Date.now();

  return yield* Effect.forEach(
    input.candidates,
    (candidate) =>
      classifyOne({
        candidate,
        waitStates: waitsByExecution.get(candidate.id) ?? [],
        waitNodes,
        checkedNodes,
        loggedNodeIds: loggedByExecution.get(candidate.id) ?? new Set(),
        targetEdges: graph.edges,
        targetVersion: input.targetVersion,
        now,
      }),
    { concurrency: NODE_OUTPUT_READ_CONCURRENCY }
  );
});
