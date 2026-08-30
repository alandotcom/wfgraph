/**
 * Intra- and cross-definition uniqueness for Events: one unfiltered source
 * name, one Inngest listener id.
 *
 * `checkIntegration` runs these on one plugin; `assembleExtensions` runs them
 * on the whole surface. The sentences are the same because the collision is.
 */

import type { EventSource } from "#src/backend/extensions/define-event";
import { toListenerFunctionId } from "#src/backend/lib/inngest/listener-function-id";

export type NamedEventSource = {
  readonly name: string;
  readonly source: EventSource;
};

/**
 * Two Events on one source have to be told apart by their payloads.
 *
 * `source.when` is what tells them apart, and an Event declaring none matches
 * every payload on that source. Two such Events would both be delivered every
 * time, which is one arrival counted twice: two runs where the builder configured
 * one, and the same wait woken twice.
 */
export function assertSourcesAreDistinguishable(
  events: readonly NamedEventSource[]
): void {
  const unfilteredBySource = new Map<string, string>();

  for (const event of events) {
    if (event.source.when) {
      continue;
    }

    const existing = unfilteredBySource.get(event.source.event);
    if (existing) {
      throw new Error(
        `Events "${existing}" and "${event.name}" both arrive as "${event.source.event}" and neither narrows it with source.when, so every payload would be delivered as both. Give one of them a filter, or a source name of its own.`
      );
    }
    unfilteredBySource.set(event.source.event, event.name);
  }
}

/**
 * Two Events may not slug to one Inngest function id.
 *
 * The id is `slugify(name)`, so `app/appointment.created` and
 * `app-appointment-created` are the same function to Inngest. It would sync one
 * and drop the other, which reads as an Event that quietly never arrives.
 */
export function assertDistinctListenerIds(
  events: readonly NamedEventSource[]
): void {
  const byId = new Map<string, string>();

  for (const event of events) {
    const id = toListenerFunctionId(event.name);
    const existing = byId.get(id);
    if (existing) {
      throw new Error(
        `Events "${existing}" and "${event.name}" both name the Inngest function "${id}". An Event's listener id is its name slugged, so two names differing only in punctuation collide; rename one.`
      );
    }
    byId.set(id, event.name);
  }
}
