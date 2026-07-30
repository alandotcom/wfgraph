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
import { hydrateRuntimeExtensions } from "#src/lib/runtime-extensions";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@rova/shared/extensions/catalog";
import { readExtensionCatalog } from "@rova/shared/extensions/catalog-wire";

let catalog: ExtensionCatalog = emptyExtensionCatalog;

export function getExtensionCatalog(): ExtensionCatalog {
  return catalog;
}

/**
 * Fetch the surface and decode it, once, before the first render.
 *
 * One request, both halves. The endpoint answers the catalog beside what the old
 * registries send, so this owns the fetch and hands the payload to
 * `hydrateRuntimeExtensions` as well; that call is what goes when those
 * registries do.
 *
 * Nothing here memoizes: `main.tsx` calls it once, and a second call re-reading
 * the surface is the honest answer to being called twice rather than handing back
 * a promise from whenever the first one ran.
 *
 * Every failure leaves the last decoded catalog in place. A decode that fails
 * means the editor and the server it is talking to disagree about the contract,
 * which is not something this side can repair by keeping half the document, so it
 * says so instead.
 */
export async function hydrateExtensionsFromApi(): Promise<void> {
  try {
    // Root-relative, so it has to carry the mount prefix itself: a URL starting
    // with "/" ignores <base href>, which only governs relative references.
    const response = await fetch(`${getBasePath()}/api/extensions`, {
      method: "GET",
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      return;
    }

    const payload: unknown = await response.json();

    const decoded = readExtensionCatalog(readCatalogMember(payload));
    if (decoded) {
      catalog = decoded;
    } else {
      console.warn(
        "The extension catalog from /api/extensions did not fit the wire schema in @rova/shared/extensions/catalog-wire, so the editor is drawing from the catalog it had. The server serving it is most likely a different build of Rova."
      );
    }

    hydrateRuntimeExtensions(payload);
  } catch {
    // The editor renders without a surface rather than not rendering.
  }
}

/** The `catalog` member of whatever arrived, or `undefined` if there is none. */
function readCatalogMember(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null && "catalog" in payload
    ? payload.catalog
    : undefined;
}
