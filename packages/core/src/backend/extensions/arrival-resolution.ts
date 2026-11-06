/**
 * Which Event an arrival is, decided once for every source that writes the
 * event inbox and for the delivery body that reads it back.
 *
 * An arrival with no Connection can be only an Event the host declared, and
 * an arrival with a Connection only an integration-owned Event, which reaches
 * the inbox through its integration's webhook. Within that set an arrival's
 * name is an Event's own name or the `source.event` name its Events share.
 * Assembly refuses an Event name equal to another Event's source name, so the
 * two lookups never answer differently for one name.
 */

import type { AnyEventDefinition } from "#src/backend/extensions/define-event";
import { matchesSourceFilter } from "#src/backend/extensions/event-source-filter";
import type { JsonObject } from "@wfgraph/shared/types/json";

/** An arrival as a source records it in the inbox. */
export type Arrival = {
  readonly name: string;
  readonly data: JsonObject;
  /** The Connection an integration Event arrived through, or null. */
  readonly connectionId: string | null;
};

/**
 * Which Event an arrival is.
 *
 * - `event`: the arrival is `event`, named by its own name (`via: "name"`) or
 *   by the source it arrives under, whose `source.when` filter accepted the
 *   arrival's data (`via: "source"`).
 * - `unmatched_source`: the arrival names a source, and no Event on it accepts
 *   the arrival's data. It is a subtype no Event declares, so nothing is owed
 *   it.
 * - `unknown`: the arrival names neither an Event nor a source an Event of its
 *   kind arrives under.
 */
export type ArrivalMatch =
  | { kind: "event"; event: AnyEventDefinition; via: "name" | "source" }
  | { kind: "unmatched_source" }
  | { kind: "unknown" };

/**
 * Answers which of `events` an arrival named `name` with `data` is. Both
 * lookups are keyed by a `Map`, since the name is whatever its sender wrote.
 */
function resolverOver(
  events: readonly AnyEventDefinition[]
): (arrival: Pick<Arrival, "name" | "data">) => ArrivalMatch {
  const byName = new Map(events.map((event) => [event.name, event]));
  const bySource = Map.groupBy(events, (event) => event.source.event);
  return ({ name, data }) => {
    const named = byName.get(name);
    if (named !== undefined) {
      return { kind: "event", event: named, via: "name" };
    }
    const onSource = bySource.get(name);
    if (onSource === undefined) return { kind: "unknown" };
    // `event-uniqueness.ts` keeps at most one Event on a source accepting any
    // one payload, so the first match is the only one.
    const event = onSource.find(
      (candidate) =>
        candidate.source.when === undefined ||
        matchesSourceFilter(candidate.source.when, data)
    );
    return event === undefined
      ? { kind: "unmatched_source" }
      : { kind: "event", event, via: "source" };
  };
}

/**
 * Builds `resolveArrival` over the host's own Events and the integration-owned
 * ones. A host send, the Inngest forwarders and a host's SQL insert carry no
 * Connection, so each of them can raise only a host Event.
 */
export function arrivalResolver(input: {
  hostEvents: readonly AnyEventDefinition[];
  integrationEvents: readonly AnyEventDefinition[];
}): (arrival: Arrival) => ArrivalMatch {
  const resolveHost = resolverOver(input.hostEvents);
  const resolveIntegration = resolverOver(input.integrationEvents);
  return (arrival) =>
    arrival.connectionId === null
      ? resolveHost(arrival)
      : resolveIntegration(arrival);
}
