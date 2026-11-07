/**
 * A Cloudflare Worker entry written the way the wfgraph-core/cloudflare-worker
 * skill tells an adopter to write one: `wfWorker` from `@wfgraph/core/worker`
 * as the module's default export, with every binding and secret resolved from
 * the environment inside `request`, and `wfHyperdrive` as the persistence.
 *
 * `pnpm run type-check` compiles this file against the package's real types,
 * which is the check that the documented shape still fits the API. The task
 * checks beside it import the module, so evaluating it also runs the checks
 * `wfWorker` makes when the Worker starts.
 */

import {
  defineWfGraphAuth,
  wfHyperdrive,
  wfWorker,
  WfGraphRoles,
  type WfGraphWakeQueue,
} from "@wfgraph/core/worker";
import { recordAction } from "#src/skills/host";

/** The bindings and secrets the Wrangler configuration gives the Worker. */
export type Env = {
  HYPERDRIVE: { connectionString: string };
  WFGRAPH_WAKES: WfGraphWakeQueue;
  INTEGRATION_ENCRYPTION_KEY: string;
  WFGRAPH_EVENTS_KEY: string;
};

/** Any request carrying a session cookie is an editor; the checks need no more. */
const auth = defineWfGraphAuth((request) =>
  (request.headers.get("cookie") ?? "").includes("session=")
    ? WfGraphRoles.editor
    : null
);

export default wfWorker<Env>({
  publicUrl: "https://workflows.example.com",
  request: (env) => ({
    auth,
    persistence: wfHyperdrive(env.HYPERDRIVE),
    encryption: { key: env.INTEGRATION_ENCRYPTION_KEY },
    events: { key: env.WFGRAPH_EVENTS_KEY },
    wakeQueue: env.WFGRAPH_WAKES,
  }),
  extensions: { actions: [recordAction] },
});
