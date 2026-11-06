/**
 * Intra- and cross-definition uniqueness for Events: mutually exclusive filters
 * on a shared source, and one Inngest forwarder id per name a host sends.
 *
 * `checkIntegration` runs the filter check on one plugin; `assembleExtensions`
 * runs both on the whole surface. The sentences are the same because the
 * collision is.
 */

import { groupBy, uniq } from "es-toolkit/array";
import type { EventSource } from "#src/backend/extensions/define-event";
import { toForwarderFunctionId } from "#src/backend/lib/inngest/forwarder-function-id";

export type NamedEventSource = {
  readonly name: string;
  readonly source: EventSource;
};

/**
 * Two Events on one source have to be told apart by mutually exclusive filters.
 *
 * The current filter model has one string equality, so multiple Events are
 * distinguishable only when every filter uses the same path and a unique value.
 * Different paths may overlap because one payload can satisfy both predicates.
 */
export function assertSourcesAreDistinguishable(
  events: readonly NamedEventSource[]
): void {
  const bySource = groupBy(events, (event) => event.source.event);

  for (const [source, sourceEvents] of Object.entries(bySource)) {
    if (sourceEvents.length < 2) {
      continue;
    }

    const unfiltered = sourceEvents.find((event) => !event.source.when);
    if (unfiltered) {
      const other = sourceEvents.find((event) => event !== unfiltered);
      if (sourceEvents.every((event) => !event.source.when)) {
        throw new Error(
          `Events "${unfiltered.name}" and "${other?.name}" both arrive as "${source}" and neither narrows it with source.when, so every payload would be delivered as both. Give one of them a filter, or a source name of its own.`
        );
      }

      throw new Error(
        `Events "${unfiltered.name}" and "${other?.name}" share source "${source}", but the unfiltered Event overlaps every filtered Event. Add source.when to every Event on the source, or give one a source name of its own.`
      );
    }

    const paths = new Set(sourceEvents.map((event) => event.source.when?.path));
    if (paths.size > 1) {
      throw new Error(
        `Events on source "${source}" use different source filter paths, so their predicates may overlap. Use one source.when path for every Event on the source.`
      );
    }

    const filteredByValue = new Map<string, string>();
    for (const event of sourceEvents) {
      const when = event.source.when;
      if (!when) {
        continue;
      }

      const existing = filteredByValue.get(when.equals);
      if (existing) {
        throw new Error(
          `Events "${existing}" and "${event.name}" share source "${source}" and the same source filter value "${when.equals}". Use a unique equals value for every Event on the source.`
        );
      }
      filteredByValue.set(when.equals, event.name);
    }
  }
}

/**
 * The Inngest event names a forwarder is registered for: the source of each
 * Event in `events`, once each. Events sharing an umbrella source share its
 * forwarder.
 */
export function forwardedEventNames(
  events: readonly NamedEventSource[]
): string[] {
  return uniq(events.map((event) => event.source.event));
}

/**
 * Two forwarded names may not slug to one Inngest function id.
 *
 * The id is `slugify(name)`, so `app/appointment.created` and
 * `app-appointment-created` are the same function to Inngest. It would sync one
 * and drop the other, which reads as an Event that quietly never arrives.
 */
export function assertDistinctForwarderIds(names: readonly string[]): void {
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
