/**
 * The assembled surface, held in module state.
 *
 * `/api/extensions` answers from a Hono handler and the Inngest listener set is
 * built outside any Effect runtime, so the set has to be reachable from outside
 * one. Stage 7 of ADR-0002 turns it into a service the runtime provides, the way
 * the database handle and the Inngest client go.
 *
 * One Rova per process, so one set: `createRovaApp` configures it at startup and
 * gives it back on dispose.
 */

import type { ExtensionSet } from "#src/backend/lib/extensions/extension-set";

let currentExtensions: ExtensionSet | undefined;

export function configureExtensions(set: ExtensionSet): void {
  currentExtensions = set;
}

export function clearExtensions(): void {
  currentExtensions = undefined;
}

/**
 * The set, or a throw.
 *
 * Every reader sits behind a request to an app that configured one at startup, so
 * an unset set means something ran outside an app's lifetime. Answering with an
 * empty catalog instead would give the editor a surface holding nothing and no
 * account of why.
 */
export function getExtensions(): ExtensionSet {
  if (!currentExtensions) {
    throw new Error(
      "The extension surface has not been assembled. It is configured by createRovaApp, so reaching this means something ran outside an app's lifetime."
    );
  }

  return currentExtensions;
}
