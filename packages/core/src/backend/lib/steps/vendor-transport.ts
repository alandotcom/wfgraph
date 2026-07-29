/**
 * The HTTP transport a step's effect runs with.
 *
 * `defineStep` provides this to every handler, which is what lets a plugin call
 * a vendor without saying where its HTTP client comes from. A connection test
 * is still a Promise at its edge, so it runs its own effect and provides this
 * layer itself, which is why `@rova/core/plugin` exports it.
 */

import { Layer } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";

/**
 * `fetch` read from the global at the moment of each call.
 *
 * `FetchHttpClient.Fetch` is a `Context.Reference`, and a reference caches its
 * default value on itself the first time anything reads it. Left to that
 * default, the first `globalThis.fetch` the process ever sees would be the one
 * every later request used, which is invisible in production and wrong in a
 * test that stubs fetch per case. Handing the reference a function that looks
 * the global up per call puts that lookup back where it was.
 */
export const VendorTransport: Layer.Layer<HttpClient.HttpClient> =
  Layer.provide(
    FetchHttpClient.layer,
    Layer.succeed(
      FetchHttpClient.Fetch,
      (input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init)
    )
  );
