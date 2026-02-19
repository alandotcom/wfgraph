function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInvalidIntegrationIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const ids = value.flatMap((item) => {
    const id = asNonEmptyString(item);
    return id ? [id] : [];
  });

  return ids;
}

export function getRpcErrorMessage(
  payload: unknown,
  fallback = "Request failed"
): string {
  const payloadString = asNonEmptyString(payload);
  if (payloadString) {
    return payloadString;
  }

  if (typeof payload !== "object" || payload === null) {
    return fallback;
  }

  const value = payload as {
    error?: unknown;
    message?: unknown;
    details?: unknown;
    code?: unknown;
    invalidIntegrationIds?: unknown;
  };

  const baseMessage =
    asNonEmptyString(value.error) ??
    asNonEmptyString(value.message) ??
    asNonEmptyString(value.details) ??
    fallback;

  if (value.code === "integration_validation_failed") {
    const invalidIntegrationIds = readInvalidIntegrationIds(
      value.invalidIntegrationIds
    );
    if (invalidIntegrationIds.length > 0) {
      return `${baseMessage} (invalid integration IDs: ${invalidIntegrationIds.join(", ")})`;
    }
  }

  return baseMessage;
}
