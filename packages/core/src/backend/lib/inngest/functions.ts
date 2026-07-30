import type { Inngest, InngestFunction } from "inngest";
import { db } from "#src/backend/lib/db/index";
import { Extensions } from "#src/backend/lib/effect/extensions";
import type { ExtensionSet } from "#src/backend/lib/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/lib/extensions/workflow-actions";
import type { WorkflowActions } from "#src/backend/lib/workflow-engine/actions";
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

function toFunctionId(workflowId: string): string {
  return `workflow-${workflowId}`;
}

export function buildWorkflowFunctions(
  client: Inngest,
  workflowDefinitions: WorkflowDefinition[],
  actions: WorkflowActions
): WorkflowFunction[] {
  return workflowDefinitions
    .filter((workflow) => workflow.name !== CURRENT_WORKFLOW_NAME)
    .map((workflow) =>
      createWorkflowRunRequestedFunction(client, {
        id: toFunctionId(workflow.id),
        name: workflow.name,
        workflowId: workflow.id,
        actions,
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
function buildEventListenerFunctions(
  client: Inngest,
  runtime: RovaRuntime,
  extensions: ExtensionSet
): WorkflowFunction[] {
  return extensions.events.map((event) =>
    createInngestEventListenerFunction({ client, event, runtime })
  );
}

/**
 * What the `/inngest` route ends up serving, through the surface that holds one
 * of these, and the one thing that decides how long a newly saved workflow takes
 * to appear to Inngest.
 *
 * One registry belongs to one app, which is what makes caching the functions
 * safe: each closes over that app's runtime and its client, and the app drops
 * the whole registry as the first thing it does when disposing. As a module-level
 * cache it could outlive the runtime its listeners ran services on.
 */
export type InngestFunctionRegistry = {
  /**
   * The current function list, rebuilt when the short cache expires.
   *
   * The runtime is a parameter rather than something the registry holds,
   * because the Layer graph takes the surface this sits inside: constructing one
   * before the other is what keeps that from being a cycle. The `/inngest` route
   * has the runtime in hand and passes the app's own.
   */
  get: (runtime: RovaRuntime) => Promise<WorkflowFunction[]>;
  /** Drop the list, including a build still in flight. */
  invalidate: () => void;
};

export function createInngestFunctionRegistry(
  client: Inngest
): InngestFunctionRegistry {
  let cache: { functions: WorkflowFunction[]; expiresAt: number } | null = null;
  let inflightBuild: Promise<WorkflowFunction[]> | null = null;

  async function build(runtime: RovaRuntime): Promise<WorkflowFunction[]> {
    // Ids and names only: a run function is keyed on the id and labelled with
    // the name, and the listener set comes from the catalog, so nothing here
    // reads a graph.
    const workflowDefinitions = await db.query.workflows.findMany({
      columns: { id: true, name: true },
    });

    // The surface comes off the runtime the route handed over rather than from
    // a parameter, because the Layer graph is built from it: asking the runtime
    // is what keeps the surface and the functions that dispatch against it the
    // same app's.
    const extensions = await runtime.runPromise(Extensions);
    const actions = createWorkflowActions(extensions);

    // The draft is filtered inside `buildWorkflowFunctions`, which is where the
    // rule is tested.
    return [
      ...buildWorkflowFunctions(client, workflowDefinitions, actions),
      ...buildEventListenerFunctions(client, runtime, extensions),
    ];
  }

  function invalidate(): void {
    cache = null;
    // Forgetting the in-flight promise matters on the dispose path: a build
    // started before the app began tearing down would otherwise land afterwards
    // and store listeners closed over a runtime that has been finalized.
    inflightBuild = null;
  }

  async function get(runtime: RovaRuntime): Promise<WorkflowFunction[]> {
    if (cache && Date.now() < cache.expiresAt) {
      return cache.functions;
    }

    if (inflightBuild) {
      return await inflightBuild;
    }

    // The build writes to the cache only while it is still the build this
    // registry is waiting on. An invalidation that lands mid-flight replaces or
    // clears `inflightBuild`, and the identity check is what makes that stick:
    // the abandoned build finishes and stores nothing.
    const pending: Promise<WorkflowFunction[]> = build(runtime)
      .then((functions) => {
        if (inflightBuild === pending) {
          cache = { functions, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS };
        }
        return functions;
      })
      .finally(() => {
        if (inflightBuild === pending) {
          inflightBuild = null;
        }
      });
    inflightBuild = pending;

    return await pending;
  }

  return { get, invalidate };
}
