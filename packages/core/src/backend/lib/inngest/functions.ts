import type { Inngest, InngestFunction } from "inngest";
import { Extensions } from "#src/backend/lib/effect/extensions";
// Static, now that the id helper the app assembly needs has moved to a leaf of
// its own: this import is the only reason the delivery stack loads, and this
// module is on the path of a request that serves it anyway.
import { createInngestEventListenerFunction } from "#src/backend/lib/inngest/event-listener-function";
import type { WfGraphRuntime } from "#src/backend/runtime";
import { findEvent } from "@wfgraph/shared/extensions/catalog";

/**
 * Everything this app registers with Inngest: one listener per Event in the
 * catalog. Workflow runs execute on the database executor, so Inngest delivers
 * Events and runs no workflow body.
 *
 * Nothing here depends on a saved graph, so the list is the same for the life
 * of the process. Creating, saving or deleting a workflow changes nothing here
 * and needs no re-sync.
 *
 * The runtime is a parameter rather than something the caller holds, because
 * the Layer graph takes the surface this is built for: constructing one before
 * the other is what keeps that from being a cycle. `createWfGraphApp` builds the
 * list once after the runtime exists and hands it to either Connect or HTTP
 * serve.
 *
 * v4 encodes the trigger tuple in a function's type, so the listeners have no
 * common specific type and this names the general one. `serve()` and
 * `connect()` take that same type.
 */
export async function buildInngestFunctions(
  client: Inngest,
  runtime: WfGraphRuntime
): Promise<InngestFunction.Any[]> {
  const extensions = await runtime.runPromise(Extensions);

  return extensions.events.map((event) =>
    createInngestEventListenerFunction({
      client,
      event,
      runtime,
      connectionStamped: Boolean(
        findEvent(extensions.catalog, event.name)?.integration
      ),
    })
  );
}
