import { Effect, Layer, Schema } from "effect";
import { Inngest } from "inngest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  SilentAppLoggerLayer,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { defineEvent } from "#src/backend/lib/extensions/define-event";
import {
  createInngestEventListenerFunction,
  runEventListener,
} from "#src/backend/lib/inngest/event-listener-function";
import type { RovaRuntime } from "#src/backend/runtime";
import type { EventSubscriber } from "#src/backend/services/workflows/repo";

const {
  applyLifecycleRulesMock,
  deliverToWaitsMock,
  listEventSubscribersMock,
} = vi.hoisted(() => ({
  applyLifecycleRulesMock: vi.fn(),
  deliverToWaitsMock: vi.fn(),
  listEventSubscribersMock: vi.fn(),
}));

// What this file is about is the order and the boundaries of the two halves, so
// the halves themselves are replaced; `deliver-event.test.ts` covers what each
// one does.
vi.mock("#src/backend/services/workflows/lifecycle/deliver-event", () => ({
  applyLifecycleRules: applyLifecycleRulesMock,
  deliverToWaits: deliverToWaitsMock,
  listEventSubscribers: listEventSubscribersMock,
}));

const appointmentCreated = defineEvent({
  name: "app/appointment.created",
  schema: Schema.Struct({
    appointment: Schema.Struct({
      id: Schema.String.annotate({ description: "Appointment ID" }),
    }).annotate({ description: "The appointment this event is about" }),
  }),
  correlationPath: "appointment.id",
});

const payload = { appointment: { id: "appt_1" } };

/** The steps a handler took, in the order it took them. */
function recordingStep() {
  const ids: string[] = [];
  return {
    ids,
    step: {
      run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
        ids.push(id);
        return await fn();
      },
    },
  };
}

/**
 * The runtime the handler runs its services on, which is the seam this stands on:
 * `createRovaApp` hands the real one in, and here it provides the logger plus
 * whatever a case needs.
 */
function testRuntime(services = Layer.empty): RovaRuntime {
  return {
    runPromise: (effect: Effect.Effect<unknown, unknown>) =>
      Effect.runPromise(
        Effect.provide(effect, Layer.mergeAll(SilentAppLoggerLayer, services))
      ),
  } as unknown as RovaRuntime;
}

function subscriber(overrides: Partial<EventSubscriber> = {}): EventSubscriber {
  return {
    id: "wf_1",
    name: "Appointment Reminders",
    mode: "live",
    roles: ["start"],
    correlationPath: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listEventSubscribersMock.mockReturnValue(Effect.succeed([]));
  applyLifecycleRulesMock.mockReturnValue(
    Effect.succeed({ kind: "waits_only", workflowId: "wf_1" })
  );
  deliverToWaitsMock.mockReturnValue(
    Effect.succeed({ workflowId: "wf_1", resumedWaits: 0 })
  );
});

describe("runEventListener", () => {
  // Sibling steps, in this order: a wait delivery that fails retries on its own,
  // and replaying the start above it would open a second run for one arrival.
  it("runs the lifecycle and the waits as siblings per workflow", async () => {
    listEventSubscribersMock.mockReturnValue(
      Effect.succeed([
        subscriber({ roles: ["start", "wait"] }),
        subscriber({ id: "wf_2", roles: ["start", "wait"] }),
      ])
    );
    applyLifecycleRulesMock.mockReturnValue(
      Effect.succeed({
        kind: "started",
        workflowId: "wf_1",
        executionId: "exec_new",
        supersededExecutionIds: ["exec_old"],
        failedToSupersede: [],
      })
    );
    const recorder = recordingStep();

    const result = await runEventListener({
      event: appointmentCreated,
      payload,
      arrival: { eventId: "evt_1" },
      runtime: testRuntime(),
      step: recorder.step,
    });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "lifecycle-wf_1",
      "waits-wf_1",
      "lifecycle-wf_2",
      "waits-wf_2",
    ]);
    expect(result.workflows).toHaveLength(2);

    // The run just started and the run it displaced both take no wait: one is
    // ending, and the other has parked nothing yet.
    expect(deliverToWaitsMock.mock.calls[0]?.[0].excluding).toEqual([
      "exec_new",
      "exec_old",
    ]);
  });

  // A run claimed for the Canceled outlet is on its way out, so waking its wait
  // would resume a run that is ending.
  it("keeps the Event off the waits of the runs a cancel claimed", async () => {
    listEventSubscribersMock.mockReturnValue(
      Effect.succeed([subscriber({ roles: ["cancel", "wait"] })])
    );
    applyLifecycleRulesMock.mockReturnValue(
      Effect.succeed({
        kind: "canceled",
        workflowId: "wf_1",
        canceledExecutionIds: ["exec_running", "exec_parked"],
      })
    );
    const recorder = recordingStep();

    await runEventListener({
      event: appointmentCreated,
      payload,
      arrival: {},
      runtime: testRuntime(),
      step: recorder.step,
    });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "lifecycle-wf_1",
      "waits-wf_1",
    ]);
    expect(deliverToWaitsMock.mock.calls[0]?.[0].excluding).toEqual([
      "exec_running",
      "exec_parked",
    ]);
  });

  // A workflow holding no start role is not worth a lifecycle step: preflight
  // would validate every action and integration in its graph for a delivery that
  // only wakes a wait.
  it("skips the lifecycle step for a wait-only subscriber", async () => {
    listEventSubscribersMock.mockReturnValue(
      Effect.succeed([subscriber({ roles: ["wait"] })])
    );
    const recorder = recordingStep();

    await runEventListener({
      event: appointmentCreated,
      payload,
      arrival: {},
      runtime: testRuntime(),
      step: recorder.step,
    });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "waits-wf_1",
    ]);
    expect(applyLifecycleRulesMock.mock.calls).toHaveLength(0);
  });

  // The wait role is pushed only from the parked-run read, so a subscriber
  // without it had nothing waiting on this Event when the list was built and the
  // step would resolve to zero runs.
  it("skips the wait step for a subscriber with nothing parked", async () => {
    listEventSubscribersMock.mockReturnValue(
      Effect.succeed([subscriber({ roles: ["start"] })])
    );
    const recorder = recordingStep();

    const result = await runEventListener({
      event: appointmentCreated,
      payload,
      arrival: {},
      runtime: testRuntime(),
      step: recorder.step,
    });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "lifecycle-wf_1",
    ]);
    expect(deliverToWaitsMock.mock.calls).toHaveLength(0);
    expect(result.workflows[0]?.resumedWaits).toBe(0);
  });

  // A refused start is not a refused delivery. Under first-wins the run already
  // going is the one parked on this Event, so refusing a second run is exactly
  // what leaves it the one to wake.
  it("delivers the waits of a workflow whose start was refused", async () => {
    listEventSubscribersMock.mockReturnValue(
      Effect.succeed([subscriber({ roles: ["start", "wait"] })])
    );
    const refused = {
      kind: "refused",
      workflowId: "wf_1",
      reason: "concurrency_first_wins",
    };
    applyLifecycleRulesMock.mockReturnValue(Effect.succeed(refused));
    deliverToWaitsMock.mockReturnValue(
      Effect.succeed({ workflowId: "wf_1", resumedWaits: 1 })
    );
    const recorder = recordingStep();

    const result = await runEventListener({
      event: appointmentCreated,
      payload,
      arrival: { eventId: "dlv_9" },
      runtime: testRuntime(),
      step: recorder.step,
    });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "lifecycle-wf_1",
      "waits-wf_1",
    ]);
    expect(deliverToWaitsMock.mock.calls[0]?.[0].excluding).toEqual([]);
    expect(result.workflows).toEqual([{ lifecycle: refused, resumedWaits: 1 }]);

    // The arrival travels with the delivery, so the audit row a start or a
    // refusal writes names the arrival it answered.
    expect(applyLifecycleRulesMock.mock.calls[0]?.[0].deliveryId).toBe("dlv_9");
  });

  it("delivers no waits to a workflow that is gone", async () => {
    listEventSubscribersMock.mockReturnValue(Effect.succeed([subscriber()]));
    applyLifecycleRulesMock.mockReturnValue(
      Effect.succeed({
        kind: "skipped",
        workflowId: "wf_1",
        reason: "workflow_gone",
      })
    );
    const recorder = recordingStep();

    await runEventListener({
      event: appointmentCreated,
      payload,
      arrival: {},
      runtime: testRuntime(),
      step: recorder.step,
    });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "lifecycle-wf_1",
    ]);
    expect(deliverToWaitsMock.mock.calls).toHaveLength(0);
  });

  // A payload that is not this Event will not become one on a second attempt, so
  // it fails visibly and once: Inngest retries a plain throw.
  it("throws without retrying when the payload fails the gate", async () => {
    const recorder = recordingStep();

    await expect(
      runEventListener({
        event: appointmentCreated,
        payload: { appointment: {} },
        arrival: {},
        runtime: testRuntime(),
        step: recorder.step,
      })
    ).rejects.toThrow(/Payload refused for Event/);

    expect(recorder.ids).toEqual([]);
  });

  // A rejected query is the one thing here worth retrying, so it leaves the
  // handler as itself.
  it("lets a refused query out to the retry policy", async () => {
    listEventSubscribersMock.mockReturnValue(
      Effect.fail(
        new DatabaseError({
          cause: new Error("terminating connection due to crash"),
        })
      )
    );

    const failure = await runEventListener({
      event: appointmentCreated,
      payload,
      arrival: {},
      runtime: testRuntime(stubWorkflowRepo()),
      step: recordingStep().step,
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(DatabaseError);
  });
});

/**
 * The trigger the listener is registered with.
 *
 * Several Events may share one bus source and narrow it with `source.when`, and
 * the filter is what stops each of them being invoked for every sibling subtype
 * and failing its intake gate. Constructing a client opens nothing, and none of
 * these functions is invoked.
 */
describe("createInngestEventListenerFunction", () => {
  const client = new Inngest({ id: "listener-test", isDev: true });

  type BuiltOptions = {
    opts: {
      triggers: { event: string; if?: string }[];
      throttle?: { key?: string };
    };
  };

  /** The function inngest built, read back through the options it kept. */
  function build(
    event: Parameters<typeof createInngestEventListenerFunction>[0]["event"]
  ): BuiltOptions["opts"] {
    const built = createInngestEventListenerFunction({
      client,
      event,
      runtime: testRuntime(stubWorkflowRepo()),
    });

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return (built as unknown as BuiltOptions).opts;
  }

  const vendorPayload = Schema.Struct({
    type: Schema.String.annotate({ description: "Subtype" }),
  });

  it("listens on the bus name and narrows it to this subtype", () => {
    const [trigger] = build(
      defineEvent({
        name: "vendor/appointment.created",
        schema: vendorPayload,
        source: {
          event: "vendor/webhook",
          when: { path: "type", equals: "created" },
        },
      })
    ).triggers;

    expect(trigger?.event).toBe("vendor/webhook");
    expect(trigger?.if).toBe('event.data.type == "created"');
  });

  // An Event that is its own source narrows nothing, and a filter there would
  // refuse every payload the bus carries under that name.
  it("writes no filter for an Event that declares no subtype", () => {
    const [trigger] = build(
      defineEvent({ name: "vendor/webhook", schema: vendorPayload })
    ).triggers;

    expect(trigger?.event).toBe("vendor/webhook");
    expect(trigger?.if).toBeUndefined();
  });

  // `rewriteInngestOptions` prefixes the key against the payload; what this
  // pins is that its answer reaches the function rather than being computed and
  // dropped.
  it("carries the Event's flow control onto the function", () => {
    const options = build(
      defineEvent({
        name: "vendor/webhook",
        schema: vendorPayload,
        inngest: { throttle: { limit: 2, period: "1m", key: "type" } },
      })
    );

    expect(options.throttle?.key).toBe("event.data.type");
  });
});
