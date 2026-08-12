import type { RequestEvent } from "#src/backend/lib/http/request-event";
import type { WfGraphRuntime } from "#src/backend/runtime";

export type RpcContext = {
  headers: Headers;
  /**
   * The one record this request will write, which the HTTP middleware owns and
   * writes once the answer is known. A procedure that fails puts the reason
   * here instead of logging a line of its own, so a refused call costs one
   * record rather than two. Absent when a procedure is called outside the HTTP
   * middleware, which is what a test does.
   */
  requestEvent?: RequestEvent;
  /**
   * The Effect runtime the app owns. A procedure whose service has been migrated
   * runs its Effect through this rather than reaching for a process global, so
   * the database and logger it reaches are the ones the app was built with and a
   * test can hand it different ones.
   */
  runtime: WfGraphRuntime;
};
