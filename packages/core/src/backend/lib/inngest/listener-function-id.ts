import { slugify } from "inngest";

/**
 * A function id Inngest can carry in its own identifiers.
 *
 * It sits alone in this module because the assembly checks in `extension-set.ts`
 * compare these ids while the app is being built: importing them from the listener
 * would pull the whole delivery stack -- the repositories, preflight, the engine --
 * into a file whose job is to read what the host declared.
 *
 * `slugify` is the SDK's own, so an id built here is the id Inngest would build.
 */
export function toListenerFunctionId(eventName: string): string {
  return `rova-event-${slugify(eventName)}`;
}
