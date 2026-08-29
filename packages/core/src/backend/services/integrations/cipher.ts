/**
 * The AES envelope an integration's stored config lives inside.
 *
 * A cipher is a value the app builds from its `encryption` option and hands to
 * the integration repository, so the key travels by argument rather than through
 * module state and a second app in the same process cannot read the first one's
 * secrets.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Effect, Schema } from "effect";
import { getAppLogger } from "#src/backend/lib/logger";
import type { IntegrationConfig } from "@wfgraph/shared/types/integration";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const ENCRYPTION_KEY_ENV = "INTEGRATION_ENCRYPTION_KEY";
const cipherLogger = getAppLogger("encryption");

export type EncryptionRuntimeConfig = {
  /**
   * Optional in the type so a host can pass an environment variable straight
   * through. Reading `process.env.X` gives `string | undefined`, and a required
   * `string` here would push every host into a `?? ""` that turns a missing key
   * into a malformed one. `assertValidEncryptionKey` is what rejects it, and it
   * names the two cases apart.
   */
  key: string | undefined;
};

/**
 * The key's shape, checked without building a cipher, so `createWfGraphApp` can
 * report a bad key as a bad key before it has changed anything about the process.
 *
 * An absent key and a wrong-shaped one are different mistakes with different
 * fixes, so they get different messages: the first sends the reader to their
 * secret store, the second to the value they already have. Asserting the type
 * lets the caller use the key as a string once this returns.
 */
export function assertValidEncryptionKey(
  key: string | undefined
): asserts key is string {
  const trimmed = key?.trim() ?? "";

  if (!trimmed) {
    throw new Error(
      `createWfGraphApp's encryption.key is unset. It is a 64-character hex string; read it from ${ENCRYPTION_KEY_ENV} or wherever your app keeps its secrets.`
    );
  }

  // The characters matter as much as the count: `Buffer.from(x, "hex")` stops at
  // the first non-hex digit, so a 64-character key holding one typo builds a
  // short buffer, and the throw lands at the first seal or open rather than here.
  if (!isHex(trimmed, KEY_LENGTH)) {
    throw new Error(
      "createWfGraphApp's encryption.key must be a 64-character hex string (32 bytes)"
    );
  }
}

/**
 * A stored envelope this key cannot authenticate.
 *
 * GCM's tag covers the key as well as the ciphertext, so a well-formed envelope
 * failing it means the row was sealed under a different key. That is the whole
 * process holding the wrong `encryption.key`, which is why it leaves the read
 * rather than becoming one more empty config.
 */
export class EncryptionKeyMismatch extends Schema.TaggedError<EncryptionKeyMismatch>()(
  "EncryptionKeyMismatch",
  {
    cause: Schema.Defect(),
  }
) {}

/**
 * What a person can do about a key mismatch, for whoever the failure reaches.
 *
 * A constant rather than the class's `message`, since a `Schema.TaggedError`
 * declares no message field and its `.message` is always the empty string. Every
 * handler that translates this failure words it from here.
 */
export const ENCRYPTION_KEY_MISMATCH_MESSAGE =
  "Stored integration credentials do not decrypt under this process's encryption.key. They were sealed under a different key; start the app with that key before you manage or delete the connections.";

/** Turns a config into the one column it is stored in, and back. */
export type IntegrationCipher = {
  /**
   * Synchronous: `assertValidEncryptionKey` ran at construction, so
   * `createCipheriv` gets a 32-byte key here and a fresh IV on every call.
   */
  seal: (config: IntegrationConfig) => string;
  /**
   * An empty config when the column holds something that is not one of these
   * envelopes, so that a corrupted row is a connection the editor can still show
   * and repair. A well-formed envelope that will not authenticate fails with
   * `EncryptionKeyMismatch` instead: every row in the database is then unreadable,
   * and answering an empty config for all of them looks like connections nobody
   * filled in.
   */
  open: (
    stored: unknown
  ) => Effect.Effect<IntegrationConfig, EncryptionKeyMismatch>;
};

export function createIntegrationCipher(
  config: EncryptionRuntimeConfig
): IntegrationCipher {
  assertValidEncryptionKey(config.key);
  const key = Buffer.from(config.key.trim(), "hex");

  return {
    seal: (value) => encrypt(key, JSON.stringify(value)),
    open: (stored) => {
      if (typeof stored !== "string") {
        return Effect.succeed({});
      }

      // `decrypt` throws for both unreadable cases and the sort happens here:
      // the key failure leaves, and anything else is a row the editor can still
      // show and repair.
      try {
        return Effect.succeed(
          toIntegrationConfig(JSON.parse(decrypt(key, stored)))
        );
      } catch (error) {
        if (error instanceof EncryptionKeyMismatch) {
          return Effect.fail(error);
        }

        cipherLogger.error("Failed to decrypt integration config", { error });
        return Effect.succeed({});
      }
    },
  };
}

function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/** Hex of an exact byte count, since `Buffer.from(x, "hex")` truncates instead. */
function isHex(value: string | undefined, bytes?: number): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    value.length % 2 === 0 &&
    (bytes === undefined || value.length === bytes * 2) &&
    /^[0-9a-f]+$/i.test(value)
  );
}

/**
 * The shape check in front of the decipher is what tells the two failures apart:
 * anything the format rejects was never one of these envelopes, so whatever GCM
 * then refuses can only be the key.
 */
function decrypt(key: Buffer, ciphertext: string): string {
  const parts = ciphertext.split(":");

  if (
    parts.length !== 3 ||
    !isHex(parts[0], IV_LENGTH) ||
    !isHex(parts[1], AUTH_TAG_LENGTH) ||
    !isHex(parts[2])
  ) {
    throw new Error("Invalid encrypted data format");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(parts[0], "hex")
  );
  decipher.setAuthTag(Buffer.from(parts[1], "hex"));

  try {
    return decipher.update(parts[2], "hex", "utf8") + decipher.final("utf8");
  } catch (cause) {
    throw new EncryptionKeyMismatch({ cause });
  }
}

/** A credential is a string; anything else in the JSON is not one. */
function toIntegrationConfig(parsed: unknown): IntegrationConfig {
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }

  const normalized: IntegrationConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}
