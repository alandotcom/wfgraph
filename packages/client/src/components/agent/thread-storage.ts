/**
 * The agent conversation for one workflow, kept in this browser.
 *
 * assistant-ui's `LocalRuntime` loads a thread through a history adapter and
 * hands it every message once it settles, so the adapter here is the whole
 * persistence: one `localStorage` entry per workflow holding the thread's
 * messages in the order they were written. The server keeps no conversation,
 * because the host's `auth` answers an access policy and no user identity to
 * file one under.
 *
 * Storage can be absent or refuse a write: a private window, a full quota, a
 * policy that blocks site data. Every access is wrapped so the panel then
 * works as it did before, with the thread in memory for the life of the page.
 */

import type {
  ExportedMessageRepositoryItem,
  ThreadHistoryAdapter,
  ThreadMessage,
} from "@assistant-ui/react";
import { Option, Schema } from "effect";

const STORAGE_KEY_PREFIX = "wfgraph:agent-thread:";

/** Bumped when the stored shape changes, so an older entry reads as empty. */
const STORAGE_VERSION = 1;

function storageKey(workflowId: string): string {
  return `${STORAGE_KEY_PREFIX}${workflowId}`;
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The envelope a stored thread decodes through. A message is checked only for
 * the fields the runtime indexes by, because its parts are assistant-ui's own
 * shape and were written by assistant-ui in the first place.
 */
const storedThreadSchema = Schema.Struct({
  version: Schema.Literal(STORAGE_VERSION),
  messages: Schema.Array(
    Schema.Struct({
      parentId: Schema.NullOr(Schema.String),
      message: Schema.StructWithRest(
        Schema.Struct({
          id: Schema.String,
          role: Schema.Literals(["user", "assistant", "system"]),
          createdAt: Schema.String,
          content: Schema.Array(Schema.Unknown),
        }),
        [Schema.Record(Schema.String, Schema.Unknown)]
      ),
    })
  ),
});

type StoredThread = typeof storedThreadSchema.Type;
type StoredItem = StoredThread["messages"][number];

const decodeStoredThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(storedThreadSchema)
);

function readStored(workflowId: string): StoredItem[] {
  try {
    const raw = storage()?.getItem(storageKey(workflowId));
    if (raw == null) {
      return [];
    }
    return Option.match(decodeStoredThread(raw), {
      onNone: () => [],
      onSome: (thread) => [...thread.messages],
    });
  } catch {
    return [];
  }
}

function writeStored(workflowId: string, messages: readonly StoredItem[]) {
  try {
    storage()?.setItem(
      storageKey(workflowId),
      JSON.stringify({ version: STORAGE_VERSION, messages })
    );
  } catch {
    // A full or blocked storage leaves the thread in memory, which is how
    // the panel behaved before threads were kept at all.
  }
}

/**
 * One settled message in its stored form. `createdAt` is the one field JSON
 * cannot carry as the runtime holds it.
 */
function toStored(item: ExportedMessageRepositoryItem): StoredItem {
  return {
    parentId: item.parentId,
    message: {
      ...item.message,
      createdAt: item.message.createdAt.toISOString(),
    },
  };
}

/**
 * A stored message as the runtime holds one.
 *
 * The cast is the boundary this module exists for: the envelope has been
 * decoded and the message was written from a `ThreadMessage` by `toStored`.
 */
function fromStored(item: StoredItem): ExportedMessageRepositoryItem {
  const message = {
    ...item.message,
    createdAt: new Date(item.message.createdAt),
  };
  return {
    parentId: item.parentId,
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- written from a ThreadMessage by toStored, and its envelope decoded above
    message: message as unknown as ThreadMessage,
  };
}

function upsert(workflowId: string, item: ExportedMessageRepositoryItem) {
  const stored = readStored(workflowId);
  const next = toStored(item);
  const index = stored.findIndex(
    (entry) => entry.message.id === item.message.id
  );
  writeStored(
    workflowId,
    index === -1 ? [...stored, next] : stored.with(index, next)
  );
}

/** The history adapter that keeps one workflow's thread in this browser. */
export function agentThreadHistory(workflowId: string): ThreadHistoryAdapter {
  return {
    scopeId: workflowId,
    load: async () => {
      const messages = readStored(workflowId).map(fromStored);
      return { headId: messages.at(-1)?.message.id ?? null, messages };
    },
    append: async (item) => upsert(workflowId, item),
    update: async (item) => upsert(workflowId, item),
    delete: async (items) => {
      const removed = new Set(items.map((item) => item.message.id));
      writeStored(
        workflowId,
        readStored(workflowId).filter((entry) => !removed.has(entry.message.id))
      );
    },
  };
}

/** Forgets one workflow's stored thread, for "New conversation". */
export function forgetAgentThread(workflowId: string): void {
  try {
    storage()?.removeItem(storageKey(workflowId));
  } catch {
    // Nothing stored can be read back either, so there is nothing to undo.
  }
}
