import type { InngestFunction } from "inngest";
import { db } from "#src/backend/lib/db/index";
import { getExtensions } from "#src/backend/lib/extensions/current";
import type { RovaRuntime } from "#src/backend/runtime";
import { CURRENT_WORKFLOW_NAME } from "#src/backend/lib/workflow-constants";
// Static, now that the id helper the app assembly needs has moved to a leaf of
// its own: this import is the only reason the delivery stack loads, and this
// module is on the path of a request that serves it anyway.
import { createInngestEventListenerFunction } from "./event-listener-function";
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
};

let cachedFunctions: WorkflowFunction[] = [];
let hasRegistryCache = false;
let cacheExpiresAt = 0;
let inflightRegistryBuild: Promise<WorkflowFunction[]> | null = null;

function toFunctionId(workflowId: string): string {
  return `workflow-${workflowId}`;
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

/**
 * One listener per Event, from the catalog.
 *
 * The set does not depend on any saved graph, so it is the same for the life of
 * the process: a workflow that starts on a new Event needs no Inngest re-sync,
 * because the listener for that Event was registered when the app was built.
 */
function buildEventListenerFunctions(runtime: RovaRuntime): WorkflowFunction[] {
  const events = getExtensions().events;
  if (events.length === 0) {
    return [];
  }

  return events.map((event) =>
    createInngestEventListenerFunction({ event, runtime })
  );
}

async function loadWorkflowFunctionsFromDb(
  runtime: RovaRuntime
): Promise<WorkflowFunction[]> {
  // Ids and names only. The graph column used to come too, for the per-workflow
  // event listeners derived from it; the listener set is the catalog's now, and
  // nothing here reads a graph.
  const workflowDefinitions = await db.query.workflows.findMany({
    columns: {
      id: true,
      name: true,
    },
  });

  // The draft is filtered inside `buildWorkflowFunctions`, which is where the
  // rule is tested.
  const runRequestedFunctions = buildWorkflowFunctions(workflowDefinitions);
  const eventListenerFunctions = buildEventListenerFunctions(runtime);

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
