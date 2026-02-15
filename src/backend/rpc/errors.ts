import { ORPCError } from "@orpc/server";
import type { ServiceResult } from "@/backend/lib/service-result";

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

function getErrorMessage(payload: unknown): string {
  if (typeof payload === "string" && payload.trim().length > 0) {
    return payload;
  }

  if (typeof payload !== "object" || payload === null) {
    return "Request failed";
  }

  const value = payload as {
    error?: unknown;
    message?: unknown;
    details?: unknown;
  };

  if (typeof value.error === "string" && value.error.trim().length > 0) {
    return value.error;
  }

  if (typeof value.message === "string" && value.message.trim().length > 0) {
    return value.message;
  }

  if (typeof value.details === "string" && value.details.trim().length > 0) {
    return value.details;
  }

  return "Request failed";
}

function throwOrpcError(status: number, payload: unknown): never {
  throw new ORPCError(statusToOrpcCode(status), {
    status,
    message: getErrorMessage(payload),
    data: payload,
  });
}

function isServiceResult<TData>(
  value: unknown
): value is ServiceResult<TData, number, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("ok" in value)) {
    return false;
  }

  const maybeServiceResult = value as { ok?: unknown };
  return typeof maybeServiceResult.ok === "boolean";
}

async function responseToData<TData>(response: Response): Promise<TData> {
  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throwOrpcError(response.status, payload);
  }

  return payload as TData;
}

function serviceResultToData<TData>(
  result: ServiceResult<TData, number, unknown>
): TData {
  if (!result.ok) {
    throwOrpcError(result.status, result.error);
  }

  return result.data;
}

type RpcCompatibleResult<TData> =
  | Response
  | ServiceResult<TData, number, unknown>;

export async function toRpcData<TData>(
  result: RpcCompatibleResult<TData> | Promise<RpcCompatibleResult<TData>>
): Promise<TData> {
  const resolved = await result;

  if (resolved instanceof Response) {
    return responseToData<TData>(resolved);
  }

  if (isServiceResult<TData>(resolved)) {
    return serviceResultToData<TData>(resolved);
  }

  throw new ORPCError("INTERNAL_SERVER_ERROR", {
    status: 500,
    message: "Invalid RPC handler result",
    data: null,
  });
}
