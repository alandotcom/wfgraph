import type {
  ServiceFailure,
  ServiceFailureKind,
} from "#src/backend/lib/effect/failures";

// The two endpoints that are plain Hono handlers (webhook intake and wait-hook
// resume) speak HTTP directly, so this is where a domain failure kind picks up a
// status.
const FAILURE_KIND_TO_HTTP_STATUS = {
  invalid: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  internal: 500,
} as const satisfies Record<ServiceFailureKind, number>;

/**
 * The other edge: a domain failure becomes the HTTP response those two routes
 * answer with. The body is the failure's own payload, which is the `{ error }`
 * a third-party sender has always received.
 */
export function responseFromServiceFailure(
  failure: ServiceFailure,
  init?: Omit<ResponseInit, "status">
): Response {
  return Response.json(failure.payload, {
    ...init,
    status: FAILURE_KIND_TO_HTTP_STATUS[failure.kind],
  });
}
