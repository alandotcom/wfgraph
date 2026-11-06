import { slugify } from "inngest";

/**
 * The Inngest function id of the forwarder for one Inngest event name. The
 * forwarder registers under it, and `createWfGraphInngestFunctions` compares
 * these ids to refuse two names Inngest would treat as one function.
 *
 * `slugify` is the SDK's own, so an id built here is the id Inngest would build.
 */
export function toForwarderFunctionId(eventName: string): string {
  return `wfgraph-event-${slugify(eventName)}`;
}
