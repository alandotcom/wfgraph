import type {
  ServiceFailureKind,
  ServiceResult,
} from "@/backend/lib/service-result";

// The two endpoints that are still plain Hono handlers (webhook intake and wait-hook
// resume) speak HTTP directly, so this is where a domain failure kind picks up a status.
const FAILURE_KIND_TO_HTTP_STATUS = {
  invalid: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  internal: 500,
} as const satisfies Record<ServiceFailureKind, number>;

export function responseFromServiceResult<TData, TError>(
  result: ServiceResult<TData, ServiceFailureKind, TError>,
  init?: Omit<ResponseInit, "status">
): Response {
  if (!result.ok) {
    return Response.json(result.error, {
      ...init,
      status: FAILURE_KIND_TO_HTTP_STATUS[result.kind],
    });
  }

  return Response.json(result.data, init);
}
