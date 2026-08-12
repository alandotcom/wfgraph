/**
 * The one log record a request produces, built while the request is served.
 *
 * A request passes through the HTTP middleware, the oRPC handler and a service
 * before its answer is known, and each of those knows something the others do
 * not. Rather than each writing a line of its own, each adds its fields here
 * and the middleware writes one record at the end. A field set later replaces
 * the same field set earlier.
 */

/** The same bag logtape takes for one record's structured fields. */
export type RequestEventFields = Record<string, unknown>;

export type RequestEvent = {
  /** Adds fields to the record this request will write. */
  set: (fields: RequestEventFields) => void;
  /** Everything added so far, for the middleware that writes the record. */
  fields: () => RequestEventFields;
};

export function createRequestEvent(): RequestEvent {
  const collected: RequestEventFields = {};

  return {
    set: (fields) => {
      Object.assign(collected, fields);
    },
    fields: () => collected,
  };
}
