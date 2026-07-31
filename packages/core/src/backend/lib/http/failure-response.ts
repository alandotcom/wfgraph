import type {
  ServiceFailure,
  ServiceFailureKind,
} from "#src/backend/lib/effect/failures";

// The wait resume endpoint is a plain Hono handler speaking HTTP directly, so
// this is where a domain failure kind picks up a status.
const FAILURE_KIND_TO_HTTP_STATUS = {
  invalid: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  internal: 500,
} as const satisfies Record<ServiceFailureKind, number>;

/**
 * The other edge: a domain failure becomes the HTTP response that route answers
 * with. The body is the failure's own payload, which is the `{ error }` a
 * third-party sender has always received.
 */
export function responseFromServiceFailure(failure: ServiceFailure): Response {
  return Response.json(failure.payload, {
    status: FAILURE_KIND_TO_HTTP_STATUS[failure.kind],
  });
}
