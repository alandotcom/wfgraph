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
import { annotateServiceSpan } from "#src/backend/lib/telemetry";
import {
  WorkflowRepo,
  type WorkflowRunRow,
} from "#src/backend/services/workflows/repo";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import {
  catalogFingerprint,
  graphDigest,
} from "#src/backend/services/workflows/version-digest";
import { generateId } from "@wfgraph/shared/utils/id";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  type LifecycleRules,
  readLifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { isEventSplitNode } from "@wfgraph/shared/lifecycle/event-split";
import type {
  SerializedWorkflowGraph,
  WorkflowNode,
} from "@wfgraph/shared/graph/types";

type WorkflowForPreflight = {
  graph: unknown;
};

export type WorkflowExecutionPreflight = {
  workflowGraph: SerializedWorkflowGraph;
  /**
   * The version the run pins to: the published version this preflight loaded,
   * or the draft snapshot the caller is about to mint, whose row does not exist
   * yet when this preflight receives the id.
   */
  workflowVersionId: string;
  /** Catalog fingerprint stored on that version. */
  catalogFingerprint: string;
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
 * What a start reads off either loader. `pinVersion` is the one step that has
 * to run before `preflight.workflowVersionId` is stored on an Execution: a
 * published start's is `Effect.void`, and a draft start's writes the snapshot
 * row (and may swap the id for an existing identical snapshot's).
 */
export type LoadedForRun = {
  workflow: WorkflowRunRow;
  preflight: WorkflowExecutionPreflight;
  pinVersion: Effect.Effect<void, DatabaseError>;
};

/**
 * The graph-and-catalog arm's verdict, in the form the memo holds. It carries
 * the decoded nodes as well, which the integration check reads and no caller
 * does.
 */
type GraphCheck =
  | {
      valid: true;
      workflowNodes: WorkflowNode[];
      workflowGraph: SerializedWorkflowGraph;
      lifecycleRules: LifecycleRules | undefined;
      hasEventSplit: boolean;
    }
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
  "wfgraph.execution.preflight"
)(function* (input: {
  workflow: WorkflowForPreflight;
  workflowVersionId: string;
  catalogFingerprint: string;
}) {
  // The version id is the only identifier here: the caller holds the workflow id
  // and this takes a graph rather than a row.
  yield* annotateServiceSpan({ versionId: input.workflowVersionId });
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
    if (integrationValidation.reason === "unconfigured") {
      return yield* new InvalidInput({
        error: integrationValidation.error,
      });
    }
    return yield* new IntegrationValidationFailed({
      error: "Workflow contains invalid integration references",
      invalidIntegrationIds: integrationValidation.invalidIds,
    });
  }

  const preflight: WorkflowExecutionPreflight = {
    workflowGraph: check.workflowGraph,
    workflowVersionId: input.workflowVersionId,
    catalogFingerprint: input.catalogFingerprint,
    lifecycleRules: check.lifecycleRules,
    hasEventSplit: check.hasEventSplit,
  };
  return preflight;
});
/**
 * The prelude a start needs: find the workflow, load its published version, then
 * check that version may run. A never-published workflow is refused here.
 *
 * The Event fan-out uses the same published-version load; a missing publish is a
 * skipped workflow rather than a failure a caller reads.
 */
export const loadWorkflowForRun = Effect.fn("wfgraph.execution.load_workflow")(
  function* (workflowId: string) {
    yield* annotateServiceSpan({ workflowId });
    const repo = yield* WorkflowRepo;
    const loaded = yield* repo.findByIdWithPublishedVersionForRun(workflowId);

    if (!loaded) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    const { workflow, publishedVersion: version } = loaded;
    if (!version) {
      return yield* new InvalidInput({
        error: "Workflow has not been published",
      });
    }

    yield* annotateServiceSpan({ versionId: version.id });

    const preflight = yield* runWorkflowExecutionPreflight({
      workflow: { graph: version.graph },
      workflowVersionId: version.id,
      catalogFingerprint: version.catalogFingerprint,
    });

    const result: LoadedForRun = {
      workflow,
      preflight,
      pinVersion: Effect.void,
    };
    return result;
  }
);

/**
 * The same prelude for the graph the canvas holds: read the workflow with its
 * draft graph, put that graph through the same preflight a published start runs
 * (parse, action configs, conditions, Events, integrations), and hand back the
 * version id the run will pin to. A never-published workflow is runnable this way.
 *
 * Publish's readiness battery -- templates, Event Split outlets, outlet
 * reachability -- is deliberately not asked here, so a half-built graph fails at
 * the node rather than at the request. A Draft run is what the builder reaches
 * for while the graph is still half-built.
 *
 * The workflow's Published mode is not read here. It governs Events and runs of
 * the published version; a Draft run always goes to test recipients, which
 * `postWorkflowExecute` decides on the request rather than on the graph.
 *
 * The snapshot row is not written here. `pinVersion` writes it, and the caller
 * runs that right before the one step that stores the version id on an
 * Execution, so a start turned away by a later gate (the Start Event name, the
 * Event payload, the manual-start rule, the Event Split rule, Concurrency)
 * leaves no row behind.
 */
export const loadDraftForRun = Effect.fn("wfgraph.execution.load_draft")(
  function* (workflowId: string) {
    yield* annotateServiceSpan({ workflowId });
    const repo = yield* WorkflowRepo;
    const loaded = yield* repo.findByIdWithDraftGraphForRun(workflowId);

    if (!loaded) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    const { workflow, draftGraph } = loaded;
    const { catalog } = yield* Extensions;
    const fingerprint = catalogFingerprint(catalog);
    const versionId = generateId();
    yield* annotateServiceSpan({ versionId });

    const preflight = yield* runWorkflowExecutionPreflight({
      workflow: { graph: draftGraph },
      workflowVersionId: versionId,
      catalogFingerprint: fingerprint,
    });

    // The row stores the workflow's own draft column, never the graph the
    // preflight handed back. That one comes from a memo keyed on the semantic
    // digest, which drops node positions and generated edge ids, so a memo hit
    // answers with the first graph ever validated for those semantics -- an
    // older layout of this workflow, or another workflow's. The run panel paints
    // this row, so a hit would show the builder positions they have since moved.
    // The digest is unaffected either way, being the memo key itself.
    //
    // The repository may answer with an earlier snapshot holding this exact
    // graph, so the id the run pins to is the one the row carries, which is why
    // `preflight.workflowVersionId` is rewritten here rather than trusted.
    const pinVersion = Effect.map(
      repo.freezeDraftSnapshot({
        workflowId,
        versionId,
        graph: draftGraph,
        catalogFingerprint: fingerprint,
        graphDigest: graphDigest(draftGraph),
      }),
      (snapshot) => {
        preflight.workflowVersionId = snapshot.id;
      }
    );

    const result: LoadedForRun = { workflow, preflight, pinVersion };
    return result;
  }
);
