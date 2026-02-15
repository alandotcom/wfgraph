export function getRpcErrorMessage(
  payload: unknown,
  fallback = "Request failed"
): string {
  if (typeof payload === "string" && payload.trim().length > 0) {
    return payload;
  }

  if (typeof payload !== "object" || payload === null) {
    return fallback;
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

  return fallback;
}
