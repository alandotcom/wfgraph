import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getAppLogger } from "#src/backend/lib/logger";
import type { IntegrationConfig } from "@rova/shared/types/integration";
import { db } from "./index";
import { integrations, type NewIntegration } from "./schema";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const ENCRYPTION_KEY_ENV = "INTEGRATION_ENCRYPTION_KEY";
const integrationsDbLogger = getAppLogger("integrations", "db");

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

type EncryptionRuntimeState = {
  config: EncryptionRuntimeConfig | null;
};

declare global {
  var __rovaEncryptionState: EncryptionRuntimeState | undefined;
}

const encryptionState: EncryptionRuntimeState =
  globalThis.__rovaEncryptionState ?? { config: null };

globalThis.__rovaEncryptionState = encryptionState;

/**
 * The key's shape, checked without storing it, so `createRovaApp` can report a
 * bad key as a bad key before it claims the process.
 *
 * An absent key and a wrong-shaped one are different mistakes with different
 * fixes, so they get different messages: the first sends the reader to their
 * secret store, the second to the value they already have. Asserting the type
 * lets the callers below use the key as a string once this returns.
 */
export function assertValidEncryptionKey(
  key: string | undefined
): asserts key is string {
  const trimmed = key?.trim() ?? "";

  if (!trimmed) {
    throw new Error(
      `createRovaApp's encryption.key is unset. It is a 64-character hex string; read it from ${ENCRYPTION_KEY_ENV} or wherever your app keeps its secrets.`
    );
  }

  if (trimmed.length !== 64) {
    throw new Error(
      "createRovaApp's encryption.key must be a 64-character hex string (32 bytes)"
    );
  }
}

/**
 * The one way an encryption key enters the process.
 *
 * `createRovaApp` calls this with its required `encryption` option, so the key
 * is validated once at startup rather than at the first integration read. A
 * host that keeps the key in an environment variable passes it in from there;
 * this module reading the variable itself would be a second, weaker path that
 * lets a misconfigured deployment start and fail later.
 *
 * A second call carrying a different key is refused, the way the database and
 * Inngest configuration are. Rebinding it silently would leave every row written
 * under the first key undecryptable while the process kept running as if
 * nothing had changed.
 */
export function configureEncryptionKey(config: EncryptionRuntimeConfig): void {
  assertValidEncryptionKey(config.key);
  const key = config.key.trim();

  if (encryptionState.config && encryptionState.config.key !== key) {
    throw new Error(
      "Integration encryption key is already configured with a different value. Restart the process to apply a new encryption key."
    );
  }

  encryptionState.config = { key };
}

function getEncryptionKey(): Buffer {
  const keyHex = encryptionState.config?.key;

  if (!keyHex) {
    throw new Error(
      "Integration encryption key is unset. It is configured by createRovaApp, so reaching this means an integration was read before the app was created."
    );
  }

  return Buffer.from(keyHex, "hex");
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format");
  }

  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

function encryptConfig(config: Record<string, unknown>): string {
  return encrypt(JSON.stringify(config));
}

function decryptConfig(encryptedConfig: string): Record<string, unknown> {
  try {
    const decrypted = decrypt(encryptedConfig);
    return JSON.parse(decrypted);
  } catch (error) {
    integrationsDbLogger.error("Failed to decrypt integration config", {
      error,
    });
    return {};
  }
}

function toIntegrationConfig(
  config: Record<string, unknown>
): IntegrationConfig {
  const normalized: IntegrationConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

function decryptIntegrationConfig(rawConfig: unknown): IntegrationConfig {
  if (typeof rawConfig !== "string") {
    return {};
  }
  return toIntegrationConfig(decryptConfig(rawConfig));
}

export type DecryptedIntegration = {
  id: string;
  name: string;
  type: string;
  config: IntegrationConfig;
  isManaged: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function getIntegrations(
  type?: string
): Promise<DecryptedIntegration[]> {
  const results = type
    ? await db.select().from(integrations).where(eq(integrations.type, type))
    : await db.select().from(integrations);

  return results.map((integration) => ({
    ...integration,
    config: decryptIntegrationConfig(integration.config),
  }));
}

export async function getIntegration(
  integrationId: string
): Promise<DecryptedIntegration | null> {
  const result = await db
    .select()
    .from(integrations)
    .where(eq(integrations.id, integrationId))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  return {
    ...result[0],
    config: decryptIntegrationConfig(result[0].config),
  };
}

export function getIntegrationById(
  integrationId: string
): Promise<DecryptedIntegration | null> {
  return getIntegration(integrationId);
}

export async function createIntegration(
  name: string,
  type: string,
  config: IntegrationConfig
): Promise<DecryptedIntegration> {
  const encryptedConfig = encryptConfig(config);

  const [result] = await db
    .insert(integrations)
    .values({
      name,
      type,
      config: encryptedConfig,
    })
    .returning();

  return {
    ...result,
    config,
  };
}

export async function updateIntegration(
  integrationId: string,
  updates: {
    name?: string;
    config?: IntegrationConfig;
  }
): Promise<DecryptedIntegration | null> {
  const updateData: Partial<NewIntegration> = {
    updatedAt: new Date(),
  };

  if (updates.name !== undefined) {
    updateData.name = updates.name;
  }

  if (updates.config !== undefined) {
    updateData.config = encryptConfig(updates.config);
  }

  const [result] = await db
    .update(integrations)
    .set(updateData)
    .where(eq(integrations.id, integrationId))
    .returning();

  if (!result) {
    return null;
  }

  return {
    ...result,
    config: decryptIntegrationConfig(result.config),
  };
}

export async function deleteIntegration(
  integrationId: string
): Promise<boolean> {
  const result = await db
    .delete(integrations)
    .where(eq(integrations.id, integrationId))
    .returning();

  return result.length > 0;
}

export async function getIntegrationTypesByIds(
  integrationIds: string[]
): Promise<Record<string, string>> {
  if (integrationIds.length === 0) {
    return {};
  }

  const rows = await db
    .select({ id: integrations.id, type: integrations.type })
    .from(integrations)
    .where(inArray(integrations.id, integrationIds));

  return rows.reduce<Record<string, string>>((acc, row) => {
    acc[row.id] = row.type;
    return acc;
  }, {});
}
