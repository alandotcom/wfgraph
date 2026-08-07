/**
 * The workflow editor, as something a host hands to `createWfGraphApp`:
 *
 * ```ts
 * import { clientBundle } from "@wfgraph/client";
 * const wfgraph = await createWfGraphApp({ client: clientBundle, ... });
 * ```
 *
 * WfGraph's server does not depend on this package and cannot find it on its own,
 * so passing it is what turns the UI on.
 */

import { fileURLToPath } from "node:url";

/** `dir` holds index.html and the hashed asset chunks beside it. */
export const clientBundle: { dir: string } = {
  // Relative to this module, so the install layout cannot move it out from under us.
  dir: fileURLToPath(new URL("./client/", import.meta.url)),
};
