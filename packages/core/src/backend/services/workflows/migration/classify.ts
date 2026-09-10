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
  const references = input.nodes.flatMap((node) => {
    // A config is JSON. Reading it back as JSON drops a key the editor cleared
    // and leaves every template beside it in the walk.
    const config =
      reach.has(node.id) && node.data.enabled !== false
        ? readJsonObjectLeniently(node.data.config)
        : null;

    return config === null
      ? []
      : extractAllTemplateReferences(config).map((reference) => ({
          nodeId: node.id,
          field: reference.field,
          referencedNodeId: reference.nodeId,
          referencedFieldPath: reference.fieldPath,
        }));
  });

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

/** What one parked wait row's target timeout says about this run. */
type WaitTimeoutVerdict =
  /** The hop has time left, the target Wait waits for no Event, or the resolved text is no duration. */
  | "within"
  /** The resolved timeout, measured from the park, is already in the past. */
  | "elapsed"
  /** A token in the timeout names an output the run never recorded. */
  | "unresolved";

/**
 * Whether the migrated hop would time out the moment it woke.
 *
 * The park instant is the row's own `createdAt`, and both the timeout and the
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
 * legitimate reason to migrate.
 */
function waitTimeoutVerdict(input: {
  parked: ParkedWait;
  outputs: NodeOutputs;
  now: number;
}): WaitTimeoutVerdict {
  const eventTimeout = input.parked.scan.eventTimeout;
  if (eventTimeout === null) {
    return "within";
  }

  if (
    eventTimeout.tokens.some(
      (token) => !outputPathResolves(token, input.outputs)
    )
  ) {
    return "unresolved";
  }

  const timeoutMs = parseDurationMs(
    resolveTemplateString(eventTimeout.template, input.outputs)
  );

  return timeoutMs !== null &&
    input.parked.waitState.createdAt.getTime() + timeoutMs <= input.now
    ? "elapsed"
    : "within";
}

const classifyOne = Effect.fn("classifyOne")(function* (input: {
  candidate: InFlightExecutionRow;
  waitStates: WorkflowWaitState[];
  waitNodes: Map<string, WaitNodeScan>;
  targetNodes: readonly WorkflowNode[];
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

  const pending = parked
    .flatMap((entry) => entry.scan.references)
    .filter(
      (reference) =>
        !upstreamNodeIds(reference.nodeId, input.targetEdges).has(
          reference.referencedNodeId
        )
    );

  // One read answers both the timeout templates and the references, and a run
  // whose target graph asks neither question costs no read at all.
  const repo = yield* ExecutionRepo;
  const needsOutputs =
    pending.length > 0 ||
    parked.some((entry) => (entry.scan.eventTimeout?.tokens.length ?? 0) > 0);
  const outputs = toNodeOutputs(
    needsOutputs ? yield* repo.readNodeOutputs(candidate.id) : {}
  );

  const timeouts = parked.map((entry) => ({
    waitState: entry.waitState,
    verdict: waitTimeoutVerdict({
      parked: entry,
      outputs,
      now: input.now,
    }),
  }));

  const unresolvedTimeout = timeouts.find(
    (entry) => entry.verdict === "unresolved"
  );
  if (unresolvedTimeout) {
    // The token sits in the Wait's own `waitTimeout`, which is also the field
    // the reference check below names it by, so the run reads the same refusal
    // whichever check reaches it first.
    return refuse(
      "unresolved_reference",
      `${unresolvedTimeout.waitState.nodeId}.waitTimeout`
    );
  }

  const elapsed = timeouts.find((entry) => entry.verdict === "elapsed");
  if (elapsed) {
    return refuse("wait_timeout_elapsed", elapsed.waitState.nodeId);
  }

  const reachable = new Set(parked.flatMap((entry) => [...entry.scan.reach]));
  const nodeStatuses = yield* repo.listNodeStatuses(candidate.id);
  const loggedNodeIds = new Set(nodeStatuses.map((row) => row.nodeId));
  const addedAboveWait = input.targetNodes.find(
    (node) =>
      node.data.enabled !== false &&
      !isLifecycleNode(node) &&
      !reachable.has(node.id) &&
      !loggedNodeIds.has(node.id)
  );
  if (addedAboveWait) {
    return refuse("node_added_above_wait", addedAboveWait.id);
  }

  const unresolved = pending.find(
    (reference) => !referenceResolves(reference, outputs)
  );
  if (unresolved) {
    return refuse(
      "unresolved_reference",
      `${unresolved.nodeId}.${unresolved.field}`
    );
  }

  return {
    kind: "eligible",
    candidate,
    waitStates,
  } satisfies MigrationClassification;
});

/**
 * Classifies each candidate against the target version, reading the parked wait
 * rows once for the whole set, each candidate's node statuses, and one run's
 * outputs only when a template it would run needs them.
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
        targetNodes: graph.nodes,
        targetEdges: graph.edges,
        targetVersion: input.targetVersion,
        now,
      }),
    { concurrency: NODE_OUTPUT_READ_CONCURRENCY }
  );
});
