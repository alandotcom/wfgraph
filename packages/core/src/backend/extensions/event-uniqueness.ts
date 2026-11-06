/**
 * Intra- and cross-definition uniqueness for Events: mutually exclusive filters
 * on a shared source, and Event names distinct from other Events' source names.
 *
 * `checkIntegration` runs the filter check on one plugin; `assembleExtensions`
 * runs every check on the whole surface. The sentences are the same because the
 * collision is.
 */

import { groupBy } from "es-toolkit/array";
import type { EventSource } from "#src/backend/extensions/define-event";

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
 * An Event's name may not be the source name a different Event arrives
 * under.
 *
 * An inbox row is resolved by its name first and by source second, so an Event
 * named after another Event's umbrella source would take every arrival meant
 * for that source, and the filtered Events on it would never be delivered.
 */
export function assertNamesAreNotOtherSources(
  events: readonly NamedEventSource[]
): void {
  const bySource = Map.groupBy(events, (event) => event.source.event);

  for (const event of events) {
    const other = bySource
      .get(event.name)
      ?.find((candidate) => candidate.name !== event.name);
    if (other) {
      throw new Error(
        `Event "${event.name}" is named after the source Event "${other.name}" arrives under, so an arrival with that name could be either Event. Rename the Event, or give "${other.name}" a different source name.`
      );
    }
  }
}
