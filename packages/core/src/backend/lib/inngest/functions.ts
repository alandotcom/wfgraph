/**
 * What a host on Inngest registers with its own `serve` or `connect`: one
 * forwarder per name a host Event arrives under. An integration-owned Event
 * gets no forwarder, since it reaches a workflow only through its Connection,
 * which an Inngest send cannot carry. Throws at build time when two names slug
 * to one Inngest function id.
 */

import { uniq } from "es-toolkit/array";
import type { Inngest, InngestFunction } from "inngest";
import type { WfGraphExtensions } from "#src/backend/extensions/extension-set";
import type { WfGraphEvents } from "#src/backend/host-events";
import { createInngestEventForwarder } from "#src/backend/lib/inngest/event-forwarder";
import { toForwarderFunctionId } from "#src/backend/lib/inngest/forwarder-function-id";

export type CreateWfGraphInngestFunctionsOptions = {
  /** The host's own Inngest client, which every forwarder is created on. */
  client: Inngest;
  /** The same `extensions` value the app was created with. */
  extensions: WfGraphExtensions;
  /**
   * What `createWfGraphApp` or `createWfGraphRunner` answered. Each forwarder
   * sends through its `events`, so the process that registers the functions
   * holds the app or runner they write through.
   */
  app: { readonly events: WfGraphEvents };
};

/**
 * The Inngest event names a forwarder is registered for: the source of each
 * host Event, once each. An Event listed both in `events` and by an
 * integration is the integration's, as `createWfGraphApp` assembles it.
 */
function forwardedEventNames(extensions: WfGraphExtensions): string[] {
  const integrationOwned = new Set(
    (extensions.integrations ?? []).flatMap((integration) =>
      (integration.events ?? []).map((event) => event.name)
    )
  );
  return uniq(
    (extensions.events ?? [])
      .filter((event) => !integrationOwned.has(event.name))
      .map((event) => event.source.event)
  );
}

/**
 * Two forwarded names may not slug to one Inngest function id.
 *
 * The id is `slugify(name)`, so `app/appointment.created` and
 * `app-appointment-created` are the same function to Inngest. It would sync one
 * and drop the other, which reads as an Event that quietly never arrives.
 */
function assertDistinctForwarderIds(names: readonly string[]): void {
  const byId = new Map<string, string>();

  for (const name of names) {
    const id = toForwarderFunctionId(name);
    const existing = byId.get(id);
    if (existing) {
      throw new Error(
        `Events arriving as "${existing}" and "${name}" both name the Inngest function "${id}". A forwarder's id is the name it receives slugged, so two names differing only in punctuation collide; rename one.`
      );
    }
    byId.set(id, name);
  }
}

/**
 * Builds the forwarders for `extensions` on the host's client. The list
 * depends on no saved workflow, so it is built once at startup, and creating,
 * publishing or deleting a workflow needs no re-sync.
 */
export function createWfGraphInngestFunctions(
  options: CreateWfGraphInngestFunctionsOptions
): InngestFunction.Any[] {
  const names = forwardedEventNames(options.extensions);
  assertDistinctForwarderIds(names);
  return names.map((name) =>
    createInngestEventForwarder({
      client: options.client,
      name,
      events: options.app.events,
    })
  );
}
