import type { ServiceResult } from "@/backend/lib/service-result";

export function responseFromServiceResult<TData, TError>(
  result: ServiceResult<TData, number, TError>,
  init?: Omit<ResponseInit, "status">
): Response {
  if (!result.ok) {
    return Response.json(result.error, { ...init, status: result.status });
  }

  return Response.json(result.data, init);
}
