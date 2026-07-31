/**
 * The HTTP transport a step's effect runs with.
 *
 * `defineStep` provides this to every handler, which is what lets an
 * integration call an external system without saying where its HTTP client
 * comes from. `callExternalAsync` provides it for the one caller that is still
 * a Promise at its edge, a connection test, so nothing outside this package
 * names the layer.
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
export const ExternalTransport: Layer.Layer<HttpClient.HttpClient> =
  Layer.provide(
    FetchHttpClient.layer,
    Layer.succeed(
      FetchHttpClient.Fetch,
      (input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init)
    )
  );
