import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getAppLogger } from "@/backend/lib/logger";
import type {
  IntegrationConfig,
  IntegrationType,
} from "@/shared/types/integration";
import { db } from "./index";
import { integrations, type NewIntegration } from "./schema";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const ENCRYPTION_KEY_ENV = "INTEGRATION_ENCRYPTION_KEY";
const integrationsDbLogger = getAppLogger("integrations", "db");

function getEncryptionKey(): Buffer {
  const keyHex = process.env[ENCRYPTION_KEY_ENV];

  if (!keyHex) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV} environment variable is required for encrypting integration credentials`
    );
  }

  if (keyHex.length !== 64) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV} must be a 64-character hex string (32 bytes)`
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
  type: IntegrationType;
  config: IntegrationConfig;
  isManaged: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function getIntegrations(
  type?: IntegrationType
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
  type: IntegrationType,
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

export async function validateIntegrationIds(
  integrationIds: string[]
): Promise<{ valid: boolean; invalidIds?: string[] }> {
  if (integrationIds.length === 0) {
    return { valid: true };
  }

  const existingIntegrations = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(inArray(integrations.id, integrationIds));
  const existingIds = new Set(existingIntegrations.map((row) => row.id));
  const invalidIds = integrationIds.filter((id) => !existingIds.has(id));

  if (invalidIds.length > 0) {
    return { valid: false, invalidIds };
  }

  return { valid: true };
}

export async function getIntegrationTypesByIds(
  integrationIds: string[]
): Promise<Record<string, IntegrationType>> {
  if (integrationIds.length === 0) {
    return {};
  }

  const rows = await db
    .select({ id: integrations.id, type: integrations.type })
    .from(integrations)
    .where(inArray(integrations.id, integrationIds));

  return rows.reduce<Record<string, IntegrationType>>((acc, row) => {
    acc[row.id] = row.type;
    return acc;
  }, {});
}
