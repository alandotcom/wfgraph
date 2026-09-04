import type {
  ServiceFailure,
  ServiceFailureKind,
} from "#src/backend/lib/effect/failures";

// Plain Hono handlers use this table to map domain failures to HTTP statuses.
const FAILURE_KIND_TO_HTTP_STATUS = {
  invalid: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  internal: 500,
} as const satisfies Record<ServiceFailureKind, number>;

/**
 * A domain failure becomes the HTTP response a route returns. The body is the
 * failure's transport-safe payload.
 */
export function responseFromServiceFailure(failure: ServiceFailure): Response {
  return Response.json(failure.payload, {
    status: FAILURE_KIND_TO_HTTP_STATUS[failure.kind],
  });
}
