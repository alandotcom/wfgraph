/**
 * The backend's loggers, by category. Nothing here configures logtape.
 *
 * A library that calls `configure` owns a global its host also owns, so this
 * file only asks for a logger and leaves the sinks, the levels and the format
 * to whoever embedded Workflow Graph. `@wfgraph/core/logging` holds the
 * configuration a host installs, and an unconfigured logtape drops every record
 * without a warning.
 */

import { getLogger } from "@logtape/logtape";

/**
 * The one category prefix every backend logger hangs off, named after the
 * package so a host filtering `wfgraph` catches all of it and nothing else.
 * `@wfgraph/client` uses the same root in the browser.
 */
export const WFGRAPH_LOG_ROOT = "wfgraph";

/**
 * The logger for one area of the backend, named the way its module is:
 * `getAppLogger("http")` logs under `wfgraph.http`.
 */
export function getAppLogger(...category: string[]) {
  return getLogger([WFGRAPH_LOG_ROOT, ...category]);
}
