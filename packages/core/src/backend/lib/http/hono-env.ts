import type { AuthContext } from "#src/backend/lib/http/authorize";
import type { RequestEvent } from "#src/backend/lib/http/request-event";

/** Request values the Workflow Graph API app places on every Hono context. */
export type WfGraphHonoEnv = {
  Variables: {
    wfgraphMachineRoute?: true;
    wfgraphPublicRoute?: true;
    /** The access policy resolved once for this operator request. */
    wfgraphAuth?: AuthContext;
    /** The record this request will write, shared with the oRPC handler. */
    wfgraphRequestEvent: RequestEvent;
  };
};
