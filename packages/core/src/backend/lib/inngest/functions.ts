import type { InngestFunction } from "inngest";
import { db } from "#src/backend/lib/db/index";
import type { RovaRuntime } from "#src/backend/runtime";
import { CURRENT_WORKFLOW_NAME } from "#src/backend/lib/workflow-constants";
import {
  serializedWorkflowGraphSchema,
  type WorkflowTriggerConfigInput,
} from "@rova/shared/workflow/schemas";
import type { InngestEventTriggerConfig } from "@rova/shared/workflow/trigger-registry";
import { resolveWorkflowTriggerDefinition } from "@rova/shared/workflow/trigger-registry";
import { createWorkflowRunRequestedFunction } from "./workflow-function";

const REGISTRY_CACHE_TTL_MS = 5000;

/**
 * The registry holds both kinds of function side by side: run handlers, whose
 * trigger carries a schema, and event listeners, whose event names are only
 * known at runtime. v4 encodes the trigger tuple in the function's type, so
 * those two have no common specific type and the registry names the general
 * one. `serve()` takes this same type.
 */
type WorkflowFunction = InngestFunction.Any;
type WorkflowDefinition = {
  id: string;
  name: string;
  graph: unknown;
};

type EventTriggerInfo = {
  workflowId: string;
  inngestEventTrigger: InngestEventTriggerConfig;
};

let cachedFunctions: WorkflowFunction[] = [];
let hasRegistryCache = false;
let cacheExpiresAt = 0;
let inflightRegistryBuild: Promise<WorkflowFunction[]> | null = null;

function toFunctionId(workflowId: string): string {
  return `workflow-${workflowId}`;
}

function toEventListenerFunctionId(workflowId: string): string {
  return `workflow-event-${workflowId}`;
}

/**
 * Pull the trigger node's config out of the graph JSONB stored on a workflow row.
 *
 * The column is untyped JSON, so the graph goes through its schema before it is
 * read. Failure is scoped to one workflow on purpose: a graph that does not parse
 * loses only its own event listener, and every other workflow still registers.
 * A throwing parse here would take the entire function registry down with one
 * malformed row.
 */
function findTriggerNodeConfig(
  graph: unknown
): WorkflowTriggerConfigInput | undefined {
  const parsedGraph = serializedWorkflowGraphSchema.safeParse(graph);
  if (!parsedGraph.success) {
    return undefined;
  }

  for (const node of parsedGraph.data.nodes) {
    const nodeData = node.attributes.data;
    if (nodeData.type === "trigger" && nodeData.config) {
      return nodeData.config;
    }
  }

  return undefined;
}

function findEventTriggers(
  workflows: WorkflowDefinition[]
): EventTriggerInfo[] {
  const triggers: EventTriggerInfo[] = [];
  for (const workflow of workflows) {
    const triggerConfig = findTriggerNodeConfig(workflow.graph);
    if (!triggerConfig) {
      continue;
    }

    const definition = resolveWorkflowTriggerDefinition(triggerConfig);
    if (
      definition.runtime.executionType === "event" &&
      definition.runtime.inngestEventTrigger
    ) {
      triggers.push({
        workflowId: workflow.id,
        inngestEventTrigger: definition.runtime.inngestEventTrigger,
      });
    }
  }
  return triggers;
}

export function buildWorkflowFunctions(
  workflowDefinitions: WorkflowDefinition[]
): WorkflowFunction[] {
  return workflowDefinitions
    .filter((workflow) => workflow.name !== CURRENT_WORKFLOW_NAME)
    .map((workflow) =>
      createWorkflowRunRequestedFunction({
        id: toFunctionId(workflow.id),
        name: workflow.name,
        workflowId: workflow.id,
      })
    );
}

async function buildEventListenerFunctions(
  eventTriggers: EventTriggerInfo[],
  runtime: RovaRuntime
): Promise<WorkflowFunction[]> {
  if (eventTriggers.length === 0) {
    return [];
  }

  const { createInngestEventListenerFunction } =
    await import("./event-listener-function");

  return eventTriggers.map((trigger) =>
    createInngestEventListenerFunction({
      id: toEventListenerFunctionId(trigger.workflowId),
      workflowId: trigger.workflowId,
      inngestEventTrigger: trigger.inngestEventTrigger,
      runtime,
    })
  );
}

async function loadWorkflowFunctionsFromDb(
  runtime: RovaRuntime
): Promise<WorkflowFunction[]> {
  const workflowDefinitions = await db.query.workflows.findMany({
    columns: {
      id: true,
      name: true,
      graph: true,
    },
  });

  const savedWorkflows = workflowDefinitions.filter(
    (workflow) => workflow.name !== CURRENT_WORKFLOW_NAME
  );

  const runRequestedFunctions = buildWorkflowFunctions(savedWorkflows);
  const eventTriggers = findEventTriggers(savedWorkflows);
  const eventListenerFunctions = await buildEventListenerFunctions(
    eventTriggers,
    runtime
  );

  return [...runRequestedFunctions, ...eventListenerFunctions];
}

/**
 * The registry the `/inngest` route serves, rebuilt when its short cache
 * expires.
 *
 * The runtime arrives from the route rather than from a module-level handle,
 * because the event listeners built here run migrated services on it. Caching
 * functions that close over a runtime is safe because the app that owns that
 * runtime clears this cache as the first thing it does when disposing, so no
 * cached function outlives the runtime it was built against.
 */
export async function getInngestFunctions(
  runtime: RovaRuntime
): Promise<WorkflowFunction[]> {
  const now = Date.now();
  if (hasRegistryCache && now < cacheExpiresAt) {
    return cachedFunctions;
  }

  if (inflightRegistryBuild) {
    return await inflightRegistryBuild;
  }

  // The build writes to the cache only while it is still the build this module
  // is waiting on. An invalidation that lands mid-flight replaces or clears
  // `inflightRegistryBuild`, and the identity check is what makes that stick:
  // the abandoned build finishes and stores nothing.
  const build: Promise<WorkflowFunction[]> = loadWorkflowFunctionsFromDb(
    runtime
  )
    .then((functions) => {
      if (inflightRegistryBuild === build) {
        cachedFunctions = functions;
        hasRegistryCache = true;
        cacheExpiresAt = Date.now() + REGISTRY_CACHE_TTL_MS;
      }
      return functions;
    })
    .finally(() => {
      if (inflightRegistryBuild === build) {
        inflightRegistryBuild = null;
      }
    });
  inflightRegistryBuild = build;

  return await build;
}

/**
 * Drop the registry, including a build still in flight.
 *
 * Forgetting the in-flight promise matters on the dispose path: a build started
 * before the app began tearing down would otherwise land afterwards and store
 * event listeners closed over a runtime that has already been finalized.
 */
export function invalidateInngestFunctionsCache() {
  cachedFunctions = [];
  hasRegistryCache = false;
  cacheExpiresAt = 0;
  inflightRegistryBuild = null;
}
