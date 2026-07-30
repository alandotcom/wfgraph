/**
 * The route an Event is posted to, and the URL a sender copies.
 *
 * One owner for the derivation, because the server mounts the route and the editor
 * shows it: two spellings of the same path is how a builder ends up copying a 404.
 * The name is a path segment, so it is encoded -- every namespaced Event carries a
 * slash, and an unencoded one reaches a route that does not exist.
 */

/** The intake route, as Hono matches it under the API prefix. */
export const EVENT_INTAKE_ROUTE = "/events/:eventName";

export function buildEventIntakePath(eventName: string): string {
  return `/api/events/${encodeURIComponent(eventName)}`;
}

/**
 * The absolute URL, for the copy affordance in the editor.
 *
 * `origin` and `basePath` come from the browser and the mount point respectively;
 * a Rova mounted at `/workflows` answers there and nowhere else.
 */
export function buildEventIntakeUrl(input: {
  origin: string;
  basePath: string;
  eventName: string;
}): string {
  return `${input.origin}${input.basePath}${buildEventIntakePath(input.eventName)}`;
}
