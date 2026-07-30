/**
 * The extension catalog the editor draws from.
 *
 * One decoded document, held as a module value rather than a query-cache entry.
 * The surface is fixed for the life of the server process, so a cache key nothing
 * invalidates would buy nothing, and the pure functions that read it -- the ones
 * deciding what a node offers downstream -- are called during render and need it
 * synchronously.
 *
 * Read it with the lookups in `@rova/shared/extensions/catalog`, which the server
 * uses over the same document.
 */

import { getBasePath } from "#src/lib/base-path";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@rova/shared/extensions/catalog";
import {
  readExtensionCatalog,
  readExtensionsResponse,
} from "@rova/shared/extensions/catalog-wire";

let catalog: ExtensionCatalog = emptyExtensionCatalog;

export function getExtensionCatalog(): ExtensionCatalog {
  return catalog;
}

/**
 * Why a hydration did not produce a catalog.
 *
 * `unreachable` is a fetch that threw, `refused` a response that was not ok, and
 * `mismatch` a document the wire schema rejected. The three are separate because
 * only the last one means the editor and its server are different builds, and
 * the sentence a user reads about it differs.
 */
export type CatalogLoadFailure = "unreachable" | "refused" | "mismatch";

export type CatalogLoadResult =
  | { ok: true }
  | { ok: false; reason: CatalogLoadFailure };

/**
 * Fetch the surface and decode it, before the first render.
 *
 * The endpoint answers one document, and this owns the one request that reads it.
 *
 * Calling this twice re-reads the surface, which is why nothing memoizes: a
 * memoized promise would answer the second caller with the first call's document.
 *
 * Every failure leaves the last decoded catalog in place and is answered as a
 * result rather than a silent return: an empty catalog and a catalog that never
 * arrived render the same, and the editor drawn from the first tells a builder
 * their server declares nothing when the truth is that it was never asked.
 */
export async function hydrateExtensionsFromApi(): Promise<CatalogLoadResult> {
  let payload: unknown;

  // The try covers the request and nothing after it, so that a mistake in the
  // decoding below is thrown rather than read as an unreachable server.
  try {
    // Root-relative, so it has to carry the mount prefix itself: a URL starting
    // with "/" ignores <base href>, which only governs relative references.
    const response = await fetch(`${getBasePath()}/api/extensions`, {
      method: "GET",
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      return { ok: false, reason: "refused" };
    }

    payload = await response.json();
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  const envelope = readExtensionsResponse(payload);

  const decoded = readExtensionCatalog(envelope?.catalog);
  if (!decoded) {
    console.warn(
      "The extension catalog from /api/extensions did not fit the wire schema in @rova/shared/extensions/catalog-wire, so the editor is drawing from the catalog it had. The server serving it is most likely a different build of Rova."
    );
    return { ok: false, reason: "mismatch" };
  }

  catalog = decoded;
  return { ok: true };
}
