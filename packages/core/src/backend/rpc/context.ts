import type { RequestEvent } from "#src/backend/lib/http/request-event";
import type { AuthContext } from "#src/backend/lib/http/authorize";
import type { WfGraphRuntime } from "#src/backend/runtime";

export type RpcContext = {
  /** Authenticated once by Hono before the RPC or REST handler runs. */
  auth: AuthContext;
  headers: Headers;
  /**
   * The one record this request will write, which the HTTP middleware owns and
   * writes once the answer is known. A procedure that fails puts the reason
   * here instead of logging a line of its own, so a refused call costs one
   * record rather than two. Absent when a procedure is called outside the HTTP
   * middleware, which is what a test does.
   */
  requestEvent?: RequestEvent | undefined;
  /**
   * The Effect runtime the app owns. A procedure whose service has been migrated
   * runs its Effect through this rather than reaching for a process global, so
   * the database and logger it reaches are the ones the app was built with and a
   * test can hand it different ones.
   */
  runtime: WfGraphRuntime;
};
