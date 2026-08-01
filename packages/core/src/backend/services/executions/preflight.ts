import { createHash } from "node:crypto";
import { Effect } from "effect";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { Extensions } from "#src/backend/lib/effect/extensions";
import {
  IntegrationValidationFailed,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { validateWorkflowActionConfigs } from "#src/backend/services/workflows/validation/workflow-action-validation";
import { validateWorkflowConditionConfigs } from "#src/backend/services/workflows/validation/workflow-conditions-validation";
import { validateWorkflowGraph } from "#src/backend/services/workflows/validation/workflow-graph";
import { validateWorkflowIntegrations } from "#src/backend/services/workflows/validation/workflow-integration-validation";
import { validateWorkflowEvents } from "#src/backend/services/workflows/validation/workflow-lifecycle-validation";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import type { ExtensionCatalog } from "@rova/shared/extensions/catalog";
import {
  type LifecycleRules,
  readLifecycleRules,
} from "@rova/shared/lifecycle/lifecycle-rules";
import { isEventSplitNode } from "@rova/shared/lifecycle/event-split";
import type {
  SerializedWorkflowGraph,
  WorkflowNode,
} from "@rova/shared/graph/types";

type WorkflowForPreflight = {
  graph: unknown;
};

export type WorkflowExecutionPreflight = {
  workflowGraph: SerializedWorkflowGraph;
  /** The entry node's Lifecycle Rules, absent when it carries none. */
  lifecycleRules: LifecycleRules | undefined;
  /**
   * Whether the graph holds an Event Split, which routes on the Event a run is
   * on. A start that names no Event reaches such a node and leaves by no outlet,
   * so the manual entrypoint refuses one rather than opening a run that stops
   * halfway.
   */
  hasEventSplit: boolean;
};

/**
 * The graph-and-catalog arm's verdict, in the form the memo holds. It carries
 * the decoded nodes as well, which the integration check reads and no caller
 * does.
 */
type GraphCheck =
  | ({
      valid: true;
      workflowNodes: WorkflowNode[];
    } & WorkflowExecutionPreflight)
  | { valid: false; error: string };

/**
 * How many verdicts one catalog's memo holds. A workflow edited in a loop leaves
 * its older graphs' verdicts behind, and the bound is what keeps that from being
 * a leak.
 */
const GRAPH_CHECK_MEMO_LIMIT = 500;

/**
 * The memoized verdicts, one map per assembled catalog.
 *
 * Held per catalog rather than flat, because a verdict is a function of the graph
 * *and* the surface it names: an app assembled with a different plugin set
 * answers differently about the same graph. Weak so the memo goes when the app
 * that owns the catalog does.
 */
const graphCheckMemo = new WeakMap<object, Map<string, GraphCheck>>();

/**
 * The memo key: a digest of the graph itself.
 *
 * The workflow's id and `updatedAt` would be the cheaper key and the wrong one.
 * `updatedAt` has millisecond resolution, so two saves inside one millisecond
 * would share a key, and the stale verdict carries the stale graph -- which is
 * the object a start hands to the bus. Content is what the verdict is actually
 * about, and hashing it costs a fraction of the decode it saves.
 */
function graphDigest(graph: unknown): string {
  return createHash("sha1")
    .update(JSON.stringify(graph) ?? "")
    .digest("hex");
}

function readMemo(catalog: object, key: string): GraphCheck | undefined {
  return graphCheckMemo.get(catalog)?.get(key);
}

function writeMemo(catalog: object, key: string, check: GraphCheck): void {
  let entries = graphCheckMemo.get(catalog);
  if (!entries) {
    entries = new Map();
    graphCheckMemo.set(catalog, entries);
  }

  if (entries.size >= GRAPH_CHECK_MEMO_LIMIT) {
    const coldest = entries.keys().next();
    if (!coldest.done) {
      entries.delete(coldest.value);
    }
  }

  entries.set(key, check);
}

/**
 * Everything about a graph that a delivery can settle without a query: it
 * parses, its actions and conditions are configured, and every Event it names --
 * as a lifecycle role or as a Wait node's subscription -- is one this app defines.
 *
 * All of them are pure over the graph and the catalog, so the answer is memoized on
 * the pair. That is what takes the fan-out's cost off the arrival: the decode is
 * a megabyte of JSONB and the condition check compiles every Condition node and
 * every Wait node's match through the CEL type checker, once per subscribing
 * workflow per delivered Event. Nothing is skipped -- a graph that fails is
 * refused on every arrival, from the memo.
 */
function checkGraphAndCatalog(input: {
  graph: unknown;
  catalog: ExtensionCatalog;
}): GraphCheck {
  const graphValidation = validateWorkflowGraph(input.graph);
  if (!graphValidation.valid) {
    return { valid: false, error: "Workflow graph is invalid" };
  }

  const actionValidation = validateWorkflowActionConfigs(
    graphValidation.nodes,
    input.catalog
  );
  if (!actionValidation.valid) {
    return { valid: false, error: actionValidation.error };
  }

  const conditionValidation = validateWorkflowConditionConfigs(
    graphValidation.nodes
  );
  if (!conditionValidation.valid) {
    return { valid: false, error: conditionValidation.error };
  }

  const eventValidation = validateWorkflowEvents(
    graphValidation.nodes,
    input.catalog
  );
  if (!eventValidation.valid) {
    return { valid: false, error: eventValidation.error };
  }

  const lifecycleNode = graphValidation.nodes.find(
    (node) => node.data.type === "lifecycle"
  );

  return {
    valid: true,
    workflowGraph: graphValidation.graph,
    workflowNodes: graphValidation.nodes,
    lifecycleRules: readLifecycleRules(lifecycleNode?.data.config),
    hasEventSplit: graphValidation.nodes.some(isEventSplitNode),
  };
}

/**
 * Everything that has to hold before a stored graph is allowed to run: it
 * parses, its actions and conditions are configured, the integrations it names
 * exist, and the Events it names are ones the app still defines.
 *
 * The integration check is the one that stays per call, because it is the one
 * question the graph cannot answer: an integration deleted since the save
 * changes the verdict with the graph untouched. Everything above it is settled
 * once per distinct graph and read from the memo after.
 *
 * Nothing is logged here, and the refusals carry the sentence instead. One caller
 * is an entrypoint answering a person, where a refused run is an error worth
 * seeing; the other is an Event's fan-out, where the same broken graph would be
 * refused once per delivered Event and fill the error stream with a fact one
 * builder already knows. Each logs it its own way.
 */
export const runWorkflowExecutionPreflight = Effect.fn(
  "runWorkflowExecutionPreflight"
)(function* (input: { workflow: WorkflowForPreflight }) {
  const { workflow } = input;
  const { catalog } = yield* Extensions;

  const memoKey = graphDigest(workflow.graph);
  let check = readMemo(catalog, memoKey);
  if (!check) {
    check = checkGraphAndCatalog({ graph: workflow.graph, catalog });
    writeMemo(catalog, memoKey, check);
  }

  if (!check.valid) {
    return yield* new InvalidInput({ error: check.error });
  }

  // The only way this fails is the integration rows it reads, so a rejected
  // query arrives here as the same database failure a repository answers with.
  // It is last because it is the one check that costs a query.
  const integrations = yield* IntegrationRepo;
  const integrationValidation = yield* validateWorkflowIntegrations(
    check.workflowNodes,
    catalog,
    integrations.typesByIds
  );
  if (!integrationValidation.valid) {
    return yield* new IntegrationValidationFailed({
      error: "Workflow contains invalid integration references",
      invalidIntegrationIds: integrationValidation.invalidIds,
    });
  }

  const preflight: WorkflowExecutionPreflight = {
    workflowGraph: check.workflowGraph,
    lifecycleRules: check.lifecycleRules,
    hasEventSplit: check.hasEventSplit,
  };
  return preflight;
});

/**
 * The prelude the execute route needs: find the workflow it names, then check
 * that it may run. Either step's refusal is the answer the caller gets, so
 * neither is handled here.
 *
 * The Event fan-out does not use this: it has the workflow's identity from the
 * subscription index already, and it turns a refusal into a skipped workflow
 * rather than into a failure a caller reads.
 */
export const loadWorkflowForRun = Effect.fn("loadWorkflowForRun")(function* (
  workflowId: string
) {
  const repo = yield* WorkflowRepo;
  const workflow = yield* repo.findById(workflowId);

  if (!workflow) {
    return yield* new NotFound({ error: "Workflow not found" });
  }

  const preflight = yield* runWorkflowExecutionPreflight({ workflow });

  return { workflow, preflight };
});
