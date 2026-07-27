/**
 * The workflow editor, as something a host hands to `createRovaApp`.
 *
 * Rova's server does not depend on this package and cannot find it on its own.
 * A host that wants the editor imports this and passes it, so turning the UI on
 * is a line in their code rather than a consequence of what happens to be
 * installed:
 *
 * ```ts
 * import { clientBundle } from "@rova/client";
 * const rova = await createRovaApp({ client: clientBundle, ... });
 * ```
 */

import { fileURLToPath } from "node:url";

/**
 * `dir` holds index.html and the hashed asset chunks beside it. Typed
 * structurally rather than through a shared name, since `@rova/core` declares
 * the same shape and neither package depends on the other.
 */
export const clientBundle: { dir: string } = {
  // Resolved from this module's own location, so it survives whatever an
  // adopter's package manager does with the install layout.
  dir: fileURLToPath(new URL("./client/", import.meta.url)),
};
