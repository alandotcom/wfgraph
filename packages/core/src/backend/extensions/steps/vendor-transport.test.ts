/**
 * That a step's HTTP calls read `globalThis.fetch` at the moment they are made.
 *
 * `FetchHttpClient.Fetch` is a `Context.Reference`, and a reference computes its
 * default once and keeps it on itself for the life of the process. Left to that
 * default the first `fetch` anything in the process saw would serve every later
 * request, which production never notices and a suite stubbing fetch per case
 * does. Two runs against two stubs is what says the lookup happens per call, and
 * it is the whole reason `vendor-transport.ts` exists rather than
 * `FetchHttpClient.layer` being provided directly.
 */

import { Effect, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";
import { stubStepEnvironment } from "#src/backend/lib/effect/test-layers";
import { defineStep } from "#src/backend/extensions/steps/define-step";

const realFetch = globalThis.fetch;

function stubFetch(body: unknown): void {
  globalThis.fetch = (() =>
    Promise.resolve(Response.json(body))) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const step = defineStep({
  label: "Fetch",
  description: "Reads a thing over HTTP",
  category: "Demo",
  input: Schema.Struct({ url: Schema.String }),
  output: Schema.Struct({ id: Schema.String }),
  configFields: [
    { key: "url", label: "URL", type: "template-input", required: true },
  ],
  handler: Effect.fn(function* (config) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(config.url).pipe(Effect.orDie);
    const body = yield* response.json.pipe(Effect.orDie);

    return { id: String((body as { id: unknown }).id) };
  }),
});

const run = step.implement("demo/fetch")(stubStepEnvironment());

const CONTEXT = {
  executionId: "exec_1",
  nodeId: "n1",
  nodeName: "Fetch",
  nodeType: "action",
  runMode: "live",
};

describe("the transport a step's handler runs with", () => {
  it("reaches whichever fetch is installed when the step runs", async () => {
    stubFetch({ id: "first" });
    expect(
      await run({ url: "https://vendor.example/thing", _context: CONTEXT })
    ).toEqual({ success: true, data: { id: "first" } });

    stubFetch({ id: "second" });
    expect(
      await run({ url: "https://vendor.example/thing", _context: CONTEXT })
    ).toEqual({ success: true, data: { id: "second" } });
  });
});
