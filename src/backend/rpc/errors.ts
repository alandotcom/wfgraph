import { ORPCError } from "@orpc/server";
import type { ServiceResult } from "@/backend/lib/service-result";
import { getRpcErrorMessage } from "@/shared/rpc/error-message";

function statusToOrpcCode(status: number): string {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 405:
      return "METHOD_NOT_SUPPORTED";
    case 406:
      return "NOT_ACCEPTABLE";
    case 408:
      return "TIMEOUT";
    case 409:
      return "CONFLICT";
    case 412:
      return "PRECONDITION_FAILED";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 415:
      return "UNSUPPORTED_MEDIA_TYPE";
    case 422:
      return "UNPROCESSABLE_CONTENT";
    case 429:
      return "TOO_MANY_REQUESTS";
    case 499:
      return "CLIENT_CLOSED_REQUEST";
    case 500:
      return "INTERNAL_SERVER_ERROR";
    case 501:
      return "NOT_IMPLEMENTED";
    case 502:
      return "BAD_GATEWAY";
    case 503:
      return "SERVICE_UNAVAILABLE";
    case 504:
      return "GATEWAY_TIMEOUT";
    default:
      return "INTERNAL_SERVER_ERROR";
  }
}

function throwOrpcError(status: number, payload: unknown): never {
  throw new ORPCError(statusToOrpcCode(status), {
    status,
    message: getRpcErrorMessage(payload),
    data: payload,
  });
}

function serviceResultToData<TData>(
  result: ServiceResult<TData, number, unknown>
): TData {
  if (!result.ok) {
    throwOrpcError(result.status, result.error);
  }

  return result.data;
}

export type RpcCompatibleResult<TData> = ServiceResult<TData, number, unknown>;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isRpcCompatibleResult(
  value: unknown
): value is RpcCompatibleResult<unknown> {
  if (!isObjectRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }

  if (value.ok) {
    return "data" in value;
  }

  return typeof value.status === "number" && "error" in value;
}

export async function toRpcData<TData>(
  result: RpcCompatibleResult<TData> | Promise<RpcCompatibleResult<TData>>
): Promise<TData> {
  return serviceResultToData(await result);
}
