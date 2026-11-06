import type { Inngest, InngestFunction } from "inngest";
import { forwardedEventNames } from "#src/backend/extensions/event-uniqueness";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { createInngestEventForwarder } from "#src/backend/lib/inngest/event-forwarder";
import type { WfGraphRuntime } from "#src/backend/runtime";

/**
 * Everything this app registers with Inngest: one forwarder per name a host
 * Event arrives under, which records each Inngest event in the event inbox.
 * The executor delivers Events and runs workflows, so Inngest runs neither.
 * An integration-owned Event gets no forwarder: it reaches a workflow only
 * through its Connection, which an Inngest send cannot carry, so its
 * integration's webhook intake is its one source.
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
 */
export async function buildInngestFunctions(
  client: Inngest,
  runtime: WfGraphRuntime
): Promise<InngestFunction.Any[]> {
  const extensions = await runtime.runPromise(Extensions);

  return forwardedEventNames(extensions.hostEvents).map((name) =>
    createInngestEventForwarder({ client, name, runtime })
  );
}
