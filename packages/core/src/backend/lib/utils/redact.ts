/**
 * Utility functions for redacting sensitive data from inputs/outputs
 * before storage or display in observability tools
 */

import { getAppLogger } from "#src/backend/lib/logger";
import { getErrorMessage } from "@wfgraph/shared/utils";
import { type JsonObject, type JsonValue } from "@wfgraph/shared/types/json";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";

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

const SENSITIVE_TEXT_LABEL =
  "(?:[a-z0-9_-]*(?:api[_-]?key|token|secret|password|authorization|credential|private[_-]?key)[a-z0-9_-]*)";
const QUOTED_SENSITIVE_TEXT = new RegExp(
  `((?:["'])?\\b${SENSITIVE_TEXT_LABEL}\\b(?:["'])?\\s*[:=]\\s*)(["'])(.*?)\\2`,
  "gi"
);
const UNQUOTED_SENSITIVE_TEXT = new RegExp(
  `((?:["'])?\\b${SENSITIVE_TEXT_LABEL}\\b(?:["'])?\\s*[:=]\\s*)([^\\s,;&}]+)`,
  "gi"
);
const BEARER_TOKEN = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const AUTHORIZATION_CREDENTIAL =
  /(\b[a-z0-9_-]*authorization[a-z0-9_-]*\b\s*[:=]\s*)(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const URI_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi;

/** Scrub credentials embedded in an otherwise free-form error or log line. */
export function redactSensitiveText(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  return value
    .replace(URI_CREDENTIAL, "$1[REDACTED]$2")
    .replace(AUTHORIZATION_CREDENTIAL, "$1[REDACTED]")
    .replace(BEARER_TOKEN, "$1[REDACTED]")
    .replace(QUOTED_SENSITIVE_TEXT, "$1$2[REDACTED]$2")
    .replace(UNQUOTED_SENSITIVE_TEXT, "$1[REDACTED]");
}

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
  // Bound hostile or cyclic input without returning the uninspected subtree:
  // doing that would let a sensitive key bypass redaction merely by nesting it.
  if (depth > 10) {
    return "[REDACTED]";
  }

  if (obj === undefined) {
    return undefined;
  }

  if (obj === null) {
    return null;
  }

  if (typeof obj === "string") {
    return redactSensitiveText(obj) ?? undefined;
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

/**
 * Redacts a JSON-shaped value and hands it back typed as what went in.
 *
 * `redactSensitiveData` answers `JsonValue | undefined` because it also has to
 * answer for a bare scalar, or a value JSON has no spelling for at all. A
 * node's `data` is neither: it already decoded through the graph schema, so
 * nothing redaction does to it -- masking a leaf value, dropping a key that
 * holds `undefined` -- can produce a shape the caller's own type disallows.
 */
function redactJsonShaped<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the doc comment above: redaction only narrows values the input type already allows.
  return redactSensitiveData(value) as T;
}

/**
 * Redacts a pinned workflow graph before it leaves a service, the same pass
 * `redactSensitiveData` runs on a run's logged input and output. A node's
 * `data` -- most of all `data.config`, which decodes as open JSON an author
 * fills in freely -- can carry a value tried out while wiring an action: an
 * API key, a token, a test sample pasted into a Lifecycle Node's Test
 * Payloads. An edge's `data` is the same open JSON bag (`workflowEdgeAttributesSchema`
 * declares it `Schema.Record(Schema.String, Schema.Unknown)`), so it is walked
 * the same way. That value must not survive into a response built from a
 * stored graph.
 *
 * Both walks touch `data` alone rather than the whole serialized node or edge,
 * because the envelope graphology wraps each one in names its own identifier
 * field `key`, which is also the exact spelling `redactSensitiveData` masks as
 * a secret. Walking the envelope would turn every node or edge id into
 * `[REDACTED]` instead of the value an author actually typed. `data` is the
 * one open, JSON-shaped part of a node or edge; `key`, `attributes.id`,
 * `attributes.type`, `attributes.position`, `attributes.source`, and
 * `attributes.target` are graph structure the editor and the engine resolve
 * node and edge ids against, so they pass through untouched.
 */
export function redactWorkflowGraph(
  graph: SerializedWorkflowGraph
): SerializedWorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      attributes: {
        ...node.attributes,
        data: redactJsonShaped(node.attributes.data),
      },
    })),
    edges: graph.edges.map((edge) => ({
      ...edge,
      attributes: {
        ...edge.attributes,
        data: redactJsonShaped(edge.attributes.data),
      },
    })),
  };
}
