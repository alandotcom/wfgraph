import type { WfGraphRuntime } from "#src/backend/runtime";

export type RpcContext = {
  headers: Headers;
  /**
   * The Effect runtime the app owns. A procedure whose service has been migrated
   * runs its Effect through this rather than reaching for a process global, so
   * the database and logger it reaches are the ones the app was built with and a
   * test can hand it different ones.
   */
  runtime: WfGraphRuntime;
};
