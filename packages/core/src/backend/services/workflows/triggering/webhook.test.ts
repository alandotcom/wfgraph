// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { hash } from "bcryptjs";
import { Effect, Layer } from "effect";
import { NotFound, Unauthorized } from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubApiKeyRepo,
  stubExecutionRepo,
  stubInngestClient,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import type { ApiKeyCandidate } from "#src/backend/services/api-keys/repo";
import { postWorkflowWebhook } from "#src/backend/services/workflows/triggering/webhook";

/**
 * The keys one test stored, and a record of whether the workflow behind the
 * request was ever looked up.
 *
 * The order of the two checks is the point: this endpoint is reachable without
 * a session, so an unauthenticated caller must not be able to learn which
 * workflow ids exist by comparing a 401 against a 404. `workflowLookups` stays
 * empty for every rejected key, which is what pins it.
 *
 * Nothing about a run is reachable until both checks have passed, so the
 * execution repository and the event bus are left refusing every call.
 */
function makeRepos(candidates: ApiKeyCandidate[]) {
  const calls = {
    workflowLookups: [] as string[],
  };

  return {
    layer: Layer.mergeAll(
      stubApiKeyRepo({
        findByPrefix: () => Effect.succeed(candidates),
        touchLastUsed: () => Effect.void,
      }),
      stubWorkflowRepo({
        findById: (workflowId) =>
          Effect.sync(() => {
            calls.workflowLookups.push(workflowId);
            return null;
          }),
      }),
      stubExecutionRepo(),
      stubInngestClient()
    ),
    calls,
  };
}

describe("postWorkflowWebhook", () => {
  layer(SilentAppLoggerLayer)((it) => {
    it.effect("refuses a request carrying no Authorization header", () =>
      Effect.gen(function* () {
        const repos = makeRepos([]);

        const failure = yield* postWorkflowWebhook({
          workflowId: "wf_1",
          authHeader: null,
          body: {},
        }).pipe(Effect.provide(repos.layer), Effect.flip);

        assert.instanceOf(failure, Unauthorized);
        assert.strictEqual(failure.error, "Missing Authorization header");
        assert.deepStrictEqual(repos.calls.workflowLookups, []);
      })
    );

    it.effect("refuses a header that cannot hold one of our keys", () =>
      Effect.gen(function* () {
        const repos = makeRepos([]);

        const failure = yield* postWorkflowWebhook({
          workflowId: "wf_1",
          authHeader: "Bearer sk-someone-elses-key",
          body: {},
        }).pipe(Effect.provide(repos.layer), Effect.flip);

        assert.instanceOf(failure, Unauthorized);
        assert.strictEqual(failure.error, "Invalid API key format");
        assert.deepStrictEqual(repos.calls.workflowLookups, []);
      })
    );

    it.effect("refuses a well-formed key that matches nothing stored", () =>
      Effect.gen(function* () {
        const repos = makeRepos([
          {
            id: "k1",
            keyHash: yield* Effect.promise(() => hash("wfb_stored_key", 10)),
          },
        ]);

        const failure = yield* postWorkflowWebhook({
          workflowId: "wf_1",
          authHeader: "Bearer wfb_not_the_stored_key",
          body: {},
        }).pipe(Effect.provide(repos.layer), Effect.flip);

        assert.instanceOf(failure, Unauthorized);
        assert.strictEqual(failure.error, "Invalid API key");
        assert.deepStrictEqual(repos.calls.workflowLookups, []);
      })
    );

    it.effect("reports a missing workflow only once the key checks out", () =>
      Effect.gen(function* () {
        const key = "wfb_valid_key";
        const repos = makeRepos([
          { id: "k1", keyHash: yield* Effect.promise(() => hash(key, 10)) },
        ]);

        const failure = yield* postWorkflowWebhook({
          workflowId: "wf_missing",
          authHeader: `Bearer ${key}`,
          body: {},
        }).pipe(Effect.provide(repos.layer), Effect.flip);

        assert.instanceOf(failure, NotFound);
        assert.strictEqual(failure.error, "Workflow not found");
        assert.deepStrictEqual(repos.calls.workflowLookups, ["wf_missing"]);
      })
    );
  });
});
