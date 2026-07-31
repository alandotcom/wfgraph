import type { Inngest, InngestFunction } from "inngest";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { createDbWorkflowStore } from "#src/backend/engine/db-store";
import type { RovaRuntime } from "#src/backend/runtime";
// Static, now that the id helper the app assembly needs has moved to a leaf of
// its own: this import is the only reason the delivery stack loads, and this
// module is on the path of a request that serves it anyway.
import { createInngestEventListenerFunction } from "./event-listener-function";
import { createWorkflowRunFunction } from "./workflow-function";

/**
 * Everything this app registers with Inngest: the one run function, and one
 * listener per Event in the catalog.
 *
 * Neither half depends on a saved graph, so the list is the same for the life of
 * the process. Creating, saving or deleting a workflow changes nothing here and
 * needs no re-sync.
 *
 * The runtime is a parameter rather than something the caller holds, because the
 * Layer graph takes the surface this is built for: constructing one before the
 * other is what keeps that from being a cycle. The `/inngest` route has the
 * runtime in hand and passes the app's own, which is also what keeps the
 * surface, the rows and the functions that dispatch against them the same app's.
 *
 * v4 encodes the trigger tuple in a function's type, so the run function and the
 * listeners have no common specific type and this names the general one.
 * `serve()` takes that same type.
 */
export async function buildInngestFunctions(
  client: Inngest,
  runtime: RovaRuntime
): Promise<InngestFunction.Any[]> {
  const extensions = await runtime.runPromise(Extensions);

  return [
    createWorkflowRunFunction(client, {
      actions: createWorkflowActions(extensions, runtime),
      store: createDbWorkflowStore(runtime),
    }),
    ...extensions.events.map((event) =>
      createInngestEventListenerFunction({ client, event, runtime })
    ),
  ];
}
