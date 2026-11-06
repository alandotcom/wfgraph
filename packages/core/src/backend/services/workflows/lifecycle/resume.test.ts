// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  SilentAppLoggerLayer,
  stubExecutionDriver,
} from "#src/backend/lib/effect/test-layers";
import {
  DriverError,
  type ExecutionDriver,
} from "#src/backend/services/executions/driver";
import type { WorkflowWaitState } from "#src/backend/services/executions/repo";
import { resumeWaitByToken } from "#src/backend/services/workflows/lifecycle/resume";

const RESUME_TOKEN = "resume_token_1";

const liveWaitState: WorkflowWaitState = {
  id: "wait_1",
  executionId: "exec_1",
  workflowId: "wf_1",
  nodeId: "node_wait",
  nodeName: "Wait for approval",
  waitType: "event",
  status: "waiting",
  resumeToken: RESUME_TOKEN,
  waitUntil: null,
  subscribedEvents: ["appointment.confirmed"],
  metadata: null,
  createdAt: new Date("2026-03-01T00:00:00.000Z"),
  resumedAt: null,
  cancelledAt: null,
};

type ResolvePark = ExecutionDriver["Service"]["resolvePark"];

/**
 * A driver whose `resolvePark` claims the park once, the way the claim's
 * conditional write lets only one caller take a `waiting` row. Every call is
 * recorded, and a case can make the write fail instead.
 */
function makeResumeSeams(
  input: {
    waitState?: WorkflowWaitState | undefined;
    refuse?: (() => boolean) | undefined;
  } = {}
) {
  const calls: Array<Parameters<ResolvePark>[0]> = [];
  let claimed = false;
  const resolvePark: ResolvePark = (park) =>
    Effect.suspend(() => {
      calls.push(park);
      if (input.refuse?.() === true) {
        return Effect.fail(
          new DriverError({ cause: new Error("temporarily offline") })
        );
      }
      if (claimed || !input.waitState) return Effect.succeed(null);
      claimed = true;
      return Effect.succeed({ waitState: input.waitState, requeued: true });
    });

  return {
    layer: Layer.mergeAll(stubExecutionDriver({ resolvePark })),
    calls,
  };
}

describe("resumeWaitByToken", () => {
  layer(SilentAppLoggerLayer)((it) => {
    // The claim and the wake are one write: the park is taken and resolved
    // with what the Runs view sent, and the run's next pass reads it.
    it.effect(
      "claims the park by its token and resolves it with the body",
      () =>
        Effect.gen(function* () {
          const seams = makeResumeSeams({ waitState: liveWaitState });

          const resumed = yield* resumeWaitByToken({
            token: RESUME_TOKEN,
            body: { approved: true },
          }).pipe(Effect.provide(seams.layer));

          assert.deepStrictEqual(resumed, {
            success: true,
            status: "resumed",
            executionId: "exec_1",
          });
          assert.deepStrictEqual(seams.calls, [
            {
              target: { kind: "resume_token", token: RESUME_TOKEN },
              arrival: {
                signalType: "wait-resume",
                eventName: null,
                payload: { approved: true },
                deliveryId: undefined,
              },
            },
          ]);
        })
    );

    it.effect("lets only one concurrent caller resume the park", () =>
      Effect.gen(function* () {
        const seams = makeResumeSeams({ waitState: liveWaitState });

        const attempts = yield* Effect.forEach(
          [
            resumeWaitByToken({ token: RESUME_TOKEN, body: {} }),
            resumeWaitByToken({ token: RESUME_TOKEN, body: {} }),
          ],
          Effect.exit,
          { concurrency: "unbounded" }
        ).pipe(Effect.provide(seams.layer));

        assert.strictEqual(seams.calls.length, 2);
        assert.strictEqual(
          attempts.filter((attempt) => attempt._tag === "Success").length,
          1
        );
        assert.strictEqual(
          attempts.filter((attempt) => attempt._tag === "Failure").length,
          1
        );
      })
    );

    it.effect("answers not found for a token no park holds", () =>
      Effect.gen(function* () {
        const seams = makeResumeSeams();

        const failure = yield* resumeWaitByToken({
          token: RESUME_TOKEN,
          body: {},
        }).pipe(Effect.provide(seams.layer), Effect.flip);

        assert.strictEqual(failure._tag, "NotFound");
      })
    );

    // A refused write claimed nothing, so the park is still `waiting` and a
    // second request can take it.
    it.effect("allows a retry when the claim write is refused", () =>
      Effect.gen(function* () {
        let attempts = 0;
        const seams = makeResumeSeams({
          waitState: liveWaitState,
          refuse: () => {
            attempts += 1;
            return attempts === 1;
          },
        });

        const first = yield* resumeWaitByToken({
          token: RESUME_TOKEN,
          body: {},
        }).pipe(Effect.provide(seams.layer), Effect.exit);
        const second = yield* resumeWaitByToken({
          token: RESUME_TOKEN,
          body: {},
        }).pipe(Effect.provide(seams.layer), Effect.exit);

        assert.strictEqual(first._tag, "Failure");
        assert.strictEqual(second._tag, "Success");
        assert.strictEqual(attempts, 2);
      })
    );
  });
});
