/**
 * What a host on Inngest registers with its own `serve` or `connect`: one
 * forwarder per name a host Event arrives under, read from the app's
 * `events.sourceNames`. An integration-owned Event gets no forwarder, since it
 * reaches a workflow only through its Connection, which an Inngest send
 * cannot carry. Throws at build time when two names slug to one Inngest
 * function id.
 */

import type { Inngest, InngestFunction } from "inngest";
import type { WfGraphEvents } from "#src/backend/host-events";
import {
  createInngestEventForwarder,
  toForwarderFunctionId,
} from "#src/backend/lib/inngest/event-forwarder";

export type CreateWfGraphInngestFunctionsOptions = {
  /** The host's own Inngest client, which every forwarder is created on. */
  client: Inngest;
  /**
   * What `createWfGraphApp` or `createWfGraphRunner` answered. Its
   * `events.sourceNames` names the forwarders, and each forwarder sends
   * through its `events`, so the process that registers the functions holds
   * the app or runner they write through.
   */
  app: { readonly events: WfGraphEvents };
};

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
 * Builds the forwarders for the app's host Events on the host's client. The
 * list depends on no saved workflow, so it is built once at startup, and
 * creating, publishing or deleting a workflow needs no re-sync.
 */
export function createWfGraphInngestFunctions(
  options: CreateWfGraphInngestFunctionsOptions
): InngestFunction.Any[] {
  const { events } = options.app;
  assertDistinctForwarderIds(events.sourceNames);
  return events.sourceNames.map((name) =>
    createInngestEventForwarder({ client: options.client, name, events })
  );
}
