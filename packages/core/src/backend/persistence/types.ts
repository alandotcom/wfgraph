import type { Layer } from "effect";
import type { InboxInsertStatement } from "#src/backend/persistence/inbox-insert";
import type { IntegrationCipher } from "#src/backend/services/integrations/cipher";
import type { WfGraphRepositories } from "#src/backend/runtime";
import type { RunWakeSink } from "#src/backend/services/executions/wakes";

/**
 * Tells the worker loops in other processes that this process made schedule
 * rows due, and hears the same from them. A backend whose database can carry a
 * notification between processes supplies one.
 */
export type RunWakeBroadcast = RunWakeSink & {
  /**
   * Notes that a write this process committed made schedule rows due. Notes
   * are collected and sent as one notification at most every few tens of
   * milliseconds, in a transaction of their own, so the write that made the
   * rows due commits without waiting for the notification.
   */
  readonly announce: () => void;
  /**
   * Calls `onWake` for every notification another process sends, on a
   * connection held for listening alone. Resolves once that connection
   * listens; `stop` ends the listening. A notification sent while the
   * connection was down is lost, and the loop's poll finds its run instead.
   */
  readonly listen: (
    onWake: () => void
  ) => Promise<{ readonly stop: () => Promise<void> }>;
};

/**
 * What a backend's database offers the worker loops that advance runs on it.
 * Every loop polls, which is what finds a park's deadline and any wake that
 * was not heard; a producer in the loop's own process also wakes it directly.
 */
export type WfGraphRunCapabilities = {
  /** Carries wakes between processes. Absent when the database cannot. */
  readonly broadcast?: RunWakeBroadcast | undefined;
  /**
   * How many connections the backend opens at most. A loop's default
   * concurrency never exceeds it, and a host may still set more.
   */
  readonly connectionLimit: number;
  /**
   * Whether processes other than the one that opened the backend may read
   * and write its database. `one` refuses a worker loop in another process.
   */
  readonly processes: "one" | "many";
  /**
   * What a worker loop on this backend uses for each setting the host leaves
   * out. `pollMs` is absent on a backend no long-lived loop runs on, such as
   * Hyperdrive, whose tick never polls.
   */
  readonly loopDefaults: {
    readonly pollMs?: number | undefined;
    readonly concurrency: number;
  };
};

/** The resources one persistence backend gives to an app instance. */
export type WfGraphPersistenceInstance = {
  readonly repositories: Layer.Layer<WfGraphRepositories>;
  readonly capabilities: WfGraphRunCapabilities;
  readonly description: Readonly<Record<string, string | number | boolean>>;
  /**
   * The documented inbox insert a host runs on its own connection, naming
   * this backend's table, and the form its payload parameter takes. Absent on
   * a backend a host does not share, such as Hyperdrive.
   */
  readonly inboxInsert?: InboxInsertStatement | undefined;
  readonly close: () => Promise<void>;
};

/**
 * An opaque persistence backend selected by the host.
 *
 * Core asks it for repository implementations and knows nothing about its
 * driver, schema, migrations, or connection lifetime.
 */
export type WfGraphPersistence = {
  readonly open: (
    cipher: IntegrationCipher
  ) => Promise<WfGraphPersistenceInstance>;
};
