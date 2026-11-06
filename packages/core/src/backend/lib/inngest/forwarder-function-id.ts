import { slugify } from "inngest";

/**
 * The Inngest function id of the forwarder for one Inngest event name.
 *
 * It sits alone in this module because the assembly checks in
 * `event-uniqueness.ts` compare these ids while the app is being built, and
 * importing them from the forwarder would pull the driver and the repositories
 * into a file whose job is to read what the host declared.
 *
 * `slugify` is the SDK's own, so an id built here is the id Inngest would build.
 */
export function toForwarderFunctionId(eventName: string): string {
  return `wfgraph-event-${slugify(eventName)}`;
}
