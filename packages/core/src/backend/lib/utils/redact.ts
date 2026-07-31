/**
 * Utility functions for redacting sensitive data from inputs/outputs
 * before storage or display in observability tools
 */

import { getAppLogger } from "#src/backend/lib/logger";
import { getErrorMessage } from "@rova/shared/utils";
import {
  type JsonObject,
  type JsonValue,
  readJsonValue,
} from "@rova/shared/types/json";

const redactLogger = getAppLogger("utils", "redact");

/**
 * List of sensitive field keys that should be redacted
 */
const SENSITIVE_KEYS = new Set([
  // API Keys
  "apiKey",
  "api_key",
  "apikey",
  "key",

  // Credentials
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "privateKey",
  "private_key",

  // Database
  "databaseUrl",
  "database_url",
  "connectionString",
  "connection_string",

  // Email
  "fromEmail",
  "from_email",

  // Authentication
  "authorization",
  "auth",
  "bearer",

  // Credit Card/Payment
  "creditCard",
  "credit_card",
  "cardNumber",
  "card_number",
  "cvv",
  "ssn",

  // Personal Info
  "phoneNumber",
  "phone_number",
  "socialSecurity",
  "social_security",
]);

/**
 * Patterns that indicate a field contains sensitive data
 */
const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /auth/i,
];

/**
 * Check if a key name indicates sensitive data
 */
function isSensitiveKey(key: string): boolean {
  // Exact match
  if (SENSITIVE_KEYS.has(key.toLowerCase())) {
    return true;
  }

  // Pattern match
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Mask a sensitive value, showing only last 4 characters
 */
function maskValue(value: string): string {
  if (!value || value.length === 0) {
    return "[REDACTED]";
  }

  if (value.length <= 4) {
    return "****";
  }

  const last4 = value.slice(-4);
  const stars = "*".repeat(Math.min(8, value.length - 4));
  return `${stars}${last4}`;
}

/**
 * Recursively redact sensitive data from an object.
 *
 * The walk answers JSON, which is what the run-log columns hold. Anything JSON
 * has no spelling for -- a function, a symbol, a bigint -- comes back
 * `undefined`, which is what `JSON.stringify` does with the same value inside an
 * object. A `Date` reaches the object branch and becomes `{}`, since it carries
 * no own enumerable properties.
 */
function redactObject(obj: unknown, depth = 0): JsonValue | undefined {
  // Prevent infinite recursion. What is left goes in as it stands, so a subtree
  // this deep keeps whatever the walk would have masked above it. The `?? undefined`
  // keeps the JSON policy the same as every level above: a value JSON cannot
  // spell drops its key rather than turning into a stored `null`.
  if (depth > 10) {
    return readJsonValue(obj) ?? undefined;
  }

  if (obj === undefined) {
    return undefined;
  }

  if (obj === null) {
    return null;
  }

  if (typeof obj === "string") {
    return obj;
  }

  if (typeof obj === "number" || typeof obj === "boolean") {
    return obj;
  }

  if (Array.isArray(obj)) {
    // An element JSON cannot spell serializes as `null`, so it is one here.
    return obj.map((item) => redactObject(item, depth + 1) ?? null);
  }

  if (typeof obj === "object") {
    const redacted: JsonObject = {};

    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveKey(key)) {
        // A sensitive key holding no value is not a secret to mask: `undefined`
        // drops like any other key, and `null` is a value JSON can spell, so it
        // stays `null` rather than being redacted into a secret that never was.
        if (value === undefined) {
          continue;
        }
        if (value === null) {
          redacted[key] = null;
          continue;
        }
        redacted[key] =
          typeof value === "string" ? maskValue(value) : "[REDACTED]";
        continue;
      }

      // Recursively process nested objects
      const walked = redactObject(value, depth + 1);
      if (walked !== undefined) {
        redacted[key] = walked;
      }
    }

    return redacted;
  }

  return undefined;
}

/**
 * Redact sensitive data from any value
 * This is the main export that should be used throughout the application
 */
export function redactSensitiveData(data: unknown): JsonValue | undefined {
  if (data === undefined) {
    return undefined;
  }

  if (data === null) {
    return null;
  }

  try {
    return redactObject(data);
  } catch (error) {
    redactLogger.error(`Error redacting data: ${getErrorMessage(error)}`, {
      error,
    });
    return "[REDACTION_ERROR]";
  }
}
