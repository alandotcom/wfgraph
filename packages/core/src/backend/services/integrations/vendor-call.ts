/**
 * Calling an integration's own code from a service, with its throws kept in the
 * Effect channel.
 *
 * A connection test and a config-options question both reach past the database:
 * a catalog lookup, a dynamic import of a vendor module, then the vendor call.
 * Each of those can throw, and each throws for reasons the caller reports
 * differently, so the wording is passed in rather than fixed here.
 */

import { Effect } from "effect";
import type { EffectLogger } from "#src/backend/lib/effect/app-logger";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

/** How a caller words the log line for something that threw. */
export type DescribeVendorFailure = (cause: unknown) => string;

const toVendorFailure = (cause: unknown): InternalFailure =>
  new InternalFailure({
    error:
      cause instanceof Error ? cause.message : "The integration call failed",
    cause,
  });

/**
 * Run one step of a vendor call and keep its failure in the Effect channel.
 *
 * The async wrapper is what makes a synchronous throw catchable: without it
 * `run()` throws before a promise exists and the throw escapes past `catch` as
 * a defect.
 */
export const attemptVendorStep =
  (logger: EffectLogger, describe: DescribeVendorFailure) =>
  <A>(run: () => Promise<A> | A): Effect.Effect<A, InternalFailure> =>
    Effect.tryPromise({
      try: async () => await run(),
      catch: toVendorFailure,
    }).pipe(
      Effect.tapError((failure) =>
        logger.error(describe(failure.cause), { error: failure.cause })
      )
    );

/**
 * What an editor served by a different build than this process runs into: it
 * lists an integration this server does not hold, and a request naming one
 * arrives. The refusal says what is available rather than only that the request
 * was wrong, because the two builds disagreeing is the cause and the list is
 * what shows it.
 */
export function describeUnavailableIntegration(
  catalog: ExtensionCatalog,
  type: string
): string {
  const available = catalog.integrations
    .map((integration) => integration.type)
    .toSorted();

  const holds =
    available.length > 0
      ? `This server holds: ${available.join(", ")}.`
      : "This server holds no integration at all.";

  return `Integration "${type}" is not available on this server. Pass it to createWfGraphApp under extensions.integrations, or pass builtInIntegrations() from "@wfgraph/plugins" for the built-in ones. ${holds}`;
}
