import type { Layer } from "effect";
import type { IntegrationCipher } from "#src/backend/services/integrations/cipher";
import type { WfGraphRepositories } from "#src/backend/runtime";

/**
 * Tells the worker loops in other processes that this process made runs due.
 * A backend whose database can carry a notification between processes
 * supplies one.
 */
export type RunWakeBroadcast = {
  /**
   * Notes that a write this process committed made the run `executionId` due.
   * Notes are collected and sent as one notification at most every few tens of
   * milliseconds, in a transaction of their own, so the write that made the run
   * due commits without waiting for the notification.
   */
  readonly announce: (executionId: string) => void;
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
 * How the worker loops of an app on this backend learn that a run fell due.
 * Every loop polls every `pollMs`, which is what finds a park's deadline and
 * any wake that was not heard. A producer in the loop's own process also wakes
 * it directly through the app's `WorkerWake`.
 *
 * - `poll`: nothing reaches a loop in another process. SQLite runs every loop
 *   in the process that writes, and a Hyperdrive connection cannot listen.
 * - `notify`: `broadcast` carries a producer's wake to loops in other
 *   processes.
 */
export type WfGraphRunWakes =
  | { readonly kind: "poll"; readonly pollMs: number }
  | {
      readonly kind: "notify";
      readonly pollMs: number;
      readonly broadcast: RunWakeBroadcast;
    };

/** The resources one persistence backend gives to an app instance. */
export type WfGraphPersistenceInstance = {
  readonly repositories: Layer.Layer<WfGraphRepositories>;
  readonly wakes: WfGraphRunWakes;
  /**
   * How many passes an in-process worker loop runs at once unless the host
   * says otherwise: as many as the backend serves without stalling the event
   * loop or the writer.
   */
  readonly workerConcurrency: number;
  readonly description: Readonly<Record<string, string | number | boolean>>;
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
