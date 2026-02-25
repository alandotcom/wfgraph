import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ServiceResult } from "@/backend/lib/service-result";

export function respond<T, S extends ContentfulStatusCode, E>(
  c: Context,
  result: ServiceResult<T, S, E>
) {
  if (!result.ok) {
    return c.json(result.error, result.status);
  }

  return c.json(result.data);
}
