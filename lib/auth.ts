import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { integrations, users, workflows } from "@/lib/db/schema";

type PrivateSessionUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

type PrivateSession = {
  user: PrivateSessionUser;
};

const DEFAULT_OWNER_ID = "private-owner";
const DEFAULT_OWNER_NAME = "Private Owner";
const DEFAULT_OWNER_EMAIL = "private-owner@local";

let cachedOwnerId: string | null = null;

async function resolveOwnerIdFromData(): Promise<string | null> {
  const workflowOwner = await db
    .select({ userId: workflows.userId })
    .from(workflows)
    .limit(1);
  if (workflowOwner[0]?.userId) {
    return workflowOwner[0].userId;
  }

  const integrationOwner = await db
    .select({ userId: integrations.userId })
    .from(integrations)
    .limit(1);
  if (integrationOwner[0]?.userId) {
    return integrationOwner[0].userId;
  }

  const existingUser = await db.select({ id: users.id }).from(users).limit(1);
  if (existingUser[0]?.id) {
    return existingUser[0].id;
  }

  return null;
}

async function resolveOwnerId(): Promise<string> {
  if (cachedOwnerId) {
    return cachedOwnerId;
  }

  const envOwnerId = process.env.PRIVATE_OWNER_USER_ID?.trim();
  if (envOwnerId) {
    cachedOwnerId = envOwnerId;
    return cachedOwnerId;
  }

  const inferredOwnerId = await resolveOwnerIdFromData();
  cachedOwnerId = inferredOwnerId || DEFAULT_OWNER_ID;
  return cachedOwnerId;
}

async function ensureOwnerUser(ownerId: string): Promise<PrivateSessionUser> {
  const existingUser = await db.query.users.findFirst({
    where: eq(users.id, ownerId),
    columns: {
      id: true,
      name: true,
      email: true,
      image: true,
    },
  });

  if (existingUser) {
    return {
      id: existingUser.id,
      name: existingUser.name || DEFAULT_OWNER_NAME,
      email: existingUser.email || DEFAULT_OWNER_EMAIL,
      image: existingUser.image,
    };
  }

  const now = new Date();
  const name = process.env.PRIVATE_OWNER_NAME?.trim() || DEFAULT_OWNER_NAME;
  const email = process.env.PRIVATE_OWNER_EMAIL?.trim() || DEFAULT_OWNER_EMAIL;

  await db.insert(users).values({
    id: ownerId,
    name,
    email,
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
    isAnonymous: false,
  });

  return {
    id: ownerId,
    name,
    email,
    image: null,
  };
}

async function getPrivateSession(): Promise<PrivateSession> {
  const ownerId = await resolveOwnerId();
  const user = await ensureOwnerUser(ownerId);
  return { user };
}

export const auth = {
  api: {
    getSession(_: { headers?: Headers } = {}): Promise<PrivateSession> {
      return getPrivateSession();
    },
  },
};
