// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { afterEach, beforeEach, vi } from "vitest";
import { Effect } from "effect";
import { Inngest } from "inngest";
import {
  InngestClient,
  InngestError,
  makeInngestClientLayer,
} from "#src/backend/lib/effect/inngest-client";
import * as runtimeEventsModule from "#src/backend/lib/inngest/runtime-events";

/**
 * The envelope builder the live Layer delegates to, replaced so a send never
 * reaches a dev server.
 *
 * What the Layer adds over it is the error channel, and that is the whole of
 * what these tests are about: a rejected promise becomes an `InngestError`
 * keeping whatever was thrown, and a resolution travels through untouched.
 * spyOn + restore keeps isolate:false from leaving the stub on the shared
 * registry.
 */
const runtimeEvents = vi.hoisted(() => ({
  sendCatalogEvent: vi.fn(),
}));

beforeEach(() => {
  runtimeEvents.sendCatalogEvent.mockReset();
  vi.spyOn(runtimeEventsModule, "sendCatalogEvent").mockImplementation(
    runtimeEvents.sendCatalogEvent
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A real client, because constructing one opens nothing: the mocked envelope
// builder takes it as its first argument and does not call it.
const testClient = new Inngest({ id: "inngest-client-test", isDev: true });
const TestInngestClientLayer = makeInngestClientLayer(testClient);

const catalogEvent = {
  name: "resend/webhook",
  data: { type: "email.delivered" },
  connectionId: "conn_1",
};

describe("TestInngestClientLayer", () => {
  layer(TestInngestClientLayer)((it) => {
    it.effect("passes an accepted Event through on the app's client", () =>
      Effect.gen(function* () {
        runtimeEvents.sendCatalogEvent.mockResolvedValue({ ids: ["evt_1"] });

        const inngest = yield* InngestClient;
        yield* inngest.sendCatalogEvent(catalogEvent);

        // The client is the first argument of the send, which is what says the
        // Layer passes on the one it was built with.
        assert.deepStrictEqual(runtimeEvents.sendCatalogEvent.mock.lastCall, [
          testClient,
          catalogEvent,
        ]);
      })
    );

    it.effect("keeps what a refused Event threw", () =>
      Effect.gen(function* () {
        const thrown = new Error("inngest dev server unreachable");
        runtimeEvents.sendCatalogEvent.mockRejectedValue(thrown);

        const inngest = yield* InngestClient;
        const failure = yield* inngest
          .sendCatalogEvent(catalogEvent)
          .pipe(Effect.flip);

        assert.instanceOf(failure, InngestError);
        assert.strictEqual(failure.cause, thrown);
      })
    );
  });
});
