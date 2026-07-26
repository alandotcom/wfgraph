import { ORPCError } from "@orpc/server";
import type {
  ServiceFailureKind,
  ServiceResult,
} from "@/backend/lib/service-result";
import { getRpcErrorMessage } from "@/shared/rpc/error-message";

const FAILURE_KIND_TO_ORPC_CODE = {
  invalid: "BAD_REQUEST",
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
  internal: "INTERNAL_SERVER_ERROR",
} as const satisfies Record<ServiceFailureKind, string>;

function throwOrpcError(kind: ServiceFailureKind, payload: unknown): never {
  // oRPC derives the wire status from the code, so nothing here names one.
  throw new ORPCError(FAILURE_KIND_TO_ORPC_CODE[kind], {
    message: getRpcErrorMessage(payload),
    data: payload,
  });
}

function serviceResultToData<TData>(
  result: ServiceResult<TData, ServiceFailureKind, unknown>
): TData {
  if (!result.ok) {
    throwOrpcError(result.kind, result.error);
  }

  return result.data;
}

export type RpcCompatibleResult<TData> = ServiceResult<
  TData,
  ServiceFailureKind,
  unknown
>;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isServiceFailureKind(value: unknown): value is ServiceFailureKind {
  return (
    typeof value === "string" && Object.hasOwn(FAILURE_KIND_TO_ORPC_CODE, value)
  );
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

  return isServiceFailureKind(value.kind) && "error" in value;
}

export async function toRpcData<TData>(
  result: RpcCompatibleResult<TData> | Promise<RpcCompatibleResult<TData>>
): Promise<TData> {
  return serviceResultToData(await result);
}
