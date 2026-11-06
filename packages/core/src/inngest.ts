/**
 * The Inngest source, for a host that publishes Events with `inngest.send`.
 * `createWfGraphInngestFunctions` builds one Inngest function per name a host
 * Event arrives under, each sending the Inngest event into the event inbox
 * through the app's `events`. The host registers them with its own Inngest
 * `serve` or `connect`. This is the one entry that imports `inngest`, which is
 * an optional peer dependency of `@wfgraph/core`.
 */

export {
  createWfGraphInngestFunctions,
  type CreateWfGraphInngestFunctionsOptions,
} from "#src/backend/lib/inngest/functions";
