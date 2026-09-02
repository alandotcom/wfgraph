import type { AuthContext } from "#src/backend/lib/http/authorize";
import type { RequestEvent } from "#src/backend/lib/http/request-event";

/** Request values the Workflow Graph API app places on every Hono context. */
export type WfGraphHonoEnv = {
  Variables: {
    wfgraphMachineRoute?: true | undefined;
    wfgraphPublicRoute?: true | undefined;
    /** The access policy resolved once for this operator request. */
    wfgraphAuth?: AuthContext | undefined;
    /** The record this request will write, shared with the oRPC handler. */
    wfgraphRequestEvent: RequestEvent;
  };
};
