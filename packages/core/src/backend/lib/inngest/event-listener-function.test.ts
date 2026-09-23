import { Effect, Layer, Schema, SchemaTransformation } from "effect";
import { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  SilentAppLoggerLayer,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { defineEvent } from "#src/backend/extensions/define-event";
import {
  createInngestEventListenerFunction,
  type EventListenerDeliverPorts,
  runEventListener,
} from "#src/backend/lib/inngest/event-listener-function";
import type { WaitCandidatePage } from "#src/backend/services/workflows/lifecycle/deliver-event";
import type { WfGraphRuntime } from "#src/backend/runtime";
import type { EventSubscriber } from "#src/backend/services/workflows/repo";

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
const transformedEvent = defineEvent({
  name: "app/appointment.transformed",
  schema: Schema.Struct({
    appointment: Schema.Struct({
      id: Schema.String.pipe(
        Schema.decodeTo(Schema.String, SchemaTransformation.trim())
      ),
    }),
  }),
});

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

/** A small stand-in for Inngest's successful step memoization on retry. */
function memoizedStep() {
  const ids: string[] = [];
  const outputs = new Map<string, unknown>();
  return {
    ids,
    step: {
      run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
        ids.push(id);
        if (outputs.has(id)) {
          return outputs.get(id) as T;
        }
        try {
          const output = await fn();
          outputs.set(id, output);
          return output;
        } catch (error) {
          outputs.delete(id);
          throw error;
        }
      },
    },
  };
}

/**
 * The runtime the handler runs its services on, which is the seam this stands on:
 * `createWfGraphApp` hands the real one in, and here it provides the logger plus
 * whatever a case needs.
 */
function testRuntime(services = Layer.empty): WfGraphRuntime {
  return {
    runPromise: (effect: Effect.Effect<unknown, unknown>) =>
      Effect.runPromise(
        Effect.provide(effect, Layer.mergeAll(SilentAppLoggerLayer, services))
      ),
  } as unknown as WfGraphRuntime;
}

function subscriber(overrides: Partial<EventSubscriber> = {}): EventSubscriber {
  return {
    id: "wf_1",
    roles: ["start"],
    correlationPath: null,
    connectionId: null,
    ...overrides,
  };
}

/**
 * What this file is about is the order and the boundaries of the two halves,
 * so the halves themselves are fakes injected through `deliver`;
 * `deliver-event.test.ts` covers what each one does.
 */
function fakeDeliver(): EventListenerDeliverPorts & {
  applyLifecycle: ReturnType<typeof vi.fn>;
  listWaitCandidates: ReturnType<typeof vi.fn>;
  deliverWaitCandidates: ReturnType<typeof vi.fn>;
  listSubscribers: ReturnType<typeof vi.fn>;
} {
  const listSubscribers = vi.fn(() => Effect.succeed([] as EventSubscriber[]));
  const applyLifecycle = vi.fn(() =>
    Effect.succeed({ kind: "waits_only" as const, workflowId: "wf_1" })
  );
  const listWaitCandidates = vi.fn(() =>
    Effect.succeed({
      candidates: [],
      afterId: null,
      hasMore: false,
    } satisfies WaitCandidatePage)
  );
  const deliverWaitCandidates = vi.fn(() =>
    Effect.succeed({ workflowId: "wf_1", resumedWaits: 0 })
  );
  return {
    listSubscribers,
    applyLifecycle,
    listWaitCandidates,
    deliverWaitCandidates,
  };
}

describe("runEventListener", () => {
  // Candidate pages finish before their sibling delivery steps, and replaying
  // the lifecycle step after a wait failure would open a second run.
  it("runs the lifecycle and the waits as siblings per workflow", async () => {
    const deliver = fakeDeliver();
    deliver.listSubscribers.mockReturnValue(
      Effect.succeed([
        subscriber({ roles: ["start", "wait"] }),
        subscriber({ id: "wf_2", roles: ["start", "wait"] }),
      ])
    );
    deliver.applyLifecycle.mockReturnValue(
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
      deliver,
    });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "lifecycle-wf_1",
      "wait-candidates-wf_1-0",
      "waits-wf_1-0",
      "lifecycle-wf_2",
      "wait-candidates-wf_2-0",
      "waits-wf_2-0",
    ]);
    expect(result.workflows).toHaveLength(2);

    // The run just started and the run it displaced both take no wait: one is
    // ending, and the other has parked nothing yet.
    expect(
      deliver.listWaitCandidates.mock.calls[0]?.[0].excludingExecutionIds
    ).toEqual(["exec_new", "exec_old"]);
  });

  it("passes the decoded payload to Entity bindings without rewriting workflow input", async () => {
    const deliver = fakeDeliver();
    deliver.listSubscribers.mockReturnValue(
      Effect.succeed([subscriber({ roles: ["start", "wait"] })])
    );
    const recorder = recordingStep();
    const wirePayload = { appointment: { id: "  appt_1  " } };

    await runEventListener({
      event: transformedEvent,
      payload: wirePayload,
      arrival: {},
      runtime: testRuntime(),
      step: recorder.step,
      deliver,
    });

    expect(
      deliver.applyLifecycle.mock.calls[0]?.[0].event.validatedPayload
    ).toEqual({ appointment: { id: "appt_1" } });
    expect(deliver.applyLifecycle.mock.calls[0]?.[0].payload).toEqual(
      wirePayload
    );
    expect(deliver.deliverWaitCandidates.mock.calls[0]?.[0].payload).toEqual(
      wirePayload
    );
  });

  // A run claimed for the Canceled outlet is on its way out, so waking its wait
  // would resume a run that is ending.
  it("keeps the Event off the waits of the runs a cancel claimed", async () => {
    const deliver = fakeDeliver();
    deliver.listSubscribers.mockReturnValue(
      Effect.succeed([subscriber({ roles: ["cancel", "wait"] })])
    );
    deliver.applyLifecycle.mockReturnValue(
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
      deliver,
    });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "lifecycle-wf_1",
      "wait-candidates-wf_1-0",
      "waits-wf_1-0",
    ]);
    expect(
      deliver.listWaitCandidates.mock.calls[0]?.[0].excludingExecutionIds
    ).toEqual(["exec_running", "exec_parked"]);
  });

  // A workflow holding no start role is not worth a lifecycle step: preflight
  // would validate every action and integration in its graph for a delivery that
  // only wakes a wait.
  it("skips the lifecycle step for a wait-only subscriber", async () => {
    const deliver = fakeDeliver();
    deliver.listSubscribers.mockReturnValue(
      Effect.succeed([subscriber({ roles: ["wait"] })])
    );
    const recorder = recordingStep();

    await runEventListener({
      event: appointmentCreated,
      payload,
      arrival: {},
      runtime: testRuntime(),
      step: recorder.step,
      deliver,
    });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "wait-candidates-wf_1-0",
      "waits-wf_1-0",
    ]);
    expect(deliver.applyLifecycle.mock.calls).toHaveLength(0);
  });

  // The wait role is pushed only from the parked-run read, so a subscriber
  // without it had nothing waiting on this Event when the list was built and the
  // step would resolve to zero runs.
  it("skips the wait step for a subscriber with nothing parked", async () => {
    const deliver = fakeDeliver();
    deliver.listSubscribers.mockReturnValue(
      Effect.succeed([subscriber({ roles: ["start"] })])
    );
    const recorder = recordingStep();

    const result = await runEventListener({
      event: appointmentCreated,
      payload,
      arrival: {},
      runtime: testRuntime(),
      step: recorder.step,
      deliver,
    });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "lifecycle-wf_1",
    ]);
    expect(deliver.deliverWaitCandidates.mock.calls).toHaveLength(0);
    expect(result.workflows[0]?.resumedWaits).toBe(0);
  });

  // A refused start is not a refused delivery. Under first-wins the run already
  // going is the one parked on this Event, so refusing a second run is exactly
  // what leaves it the one to wake.
  it("delivers the waits of a workflow whose start was refused", async () => {
    const deliver = fakeDeliver();
    deliver.listSubscribers.mockReturnValue(
      Effect.succeed([subscriber({ roles: ["start", "wait"] })])
    );
    const refused = {
      kind: "refused",
      workflowId: "wf_1",
      reason: "concurrency_first_wins",
    };
    deliver.applyLifecycle.mockReturnValue(Effect.succeed(refused));
    deliver.deliverWaitCandidates.mockReturnValue(
      Effect.succeed({ workflowId: "wf_1", resumedWaits: 1 })
    );
    const recorder = recordingStep();

    const result = await runEventListener({
      event: appointmentCreated,
      payload,
      arrival: { eventId: "dlv_9" },
      runtime: testRuntime(),
      step: recorder.step,
      deliver,
    });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "lifecycle-wf_1",
      "wait-candidates-wf_1-0",
      "waits-wf_1-0",
    ]);
    expect(
      deliver.listWaitCandidates.mock.calls[0]?.[0].excludingExecutionIds
    ).toEqual([]);
    expect(result.workflows).toEqual([{ lifecycle: refused, resumedWaits: 1 }]);

    // The arrival travels with the delivery, so the audit row a start or a
    // refusal writes names the arrival it answered.
    expect(deliver.applyLifecycle.mock.calls[0]?.[0].deliveryId).toBe("dlv_9");
  });

  it("retries a failed delivery against saved candidates only", async () => {
    const deliver = fakeDeliver();
    deliver.listSubscribers.mockReturnValue(
      Effect.succeed([subscriber({ roles: ["wait"] })])
    );
    const originalCandidate = {
      id: "wait_original",
      executionId: "exec_original",
      nodeId: "wait_node",
      resumeToken: "token_original",
      subscribedEvents: [appointmentCreated.name],
      metadata: { waitFor: [{ event: appointmentCreated.name }] },
    };
    const laterCandidate = {
      ...originalCandidate,
      id: "wait_sequential",
      executionId: "exec_original",
      resumeToken: "token_sequential",
    };
    const otherOriginalCandidate = {
      ...originalCandidate,
      id: "wait_other",
      executionId: "exec_other",
      resumeToken: "token_other",
    };
    const currentSnapshotPages: WaitCandidatePage[] = [
      {
        candidates: [originalCandidate],
        afterId: originalCandidate.id,
        hasMore: true,
      },
      {
        candidates: [otherOriginalCandidate],
        afterId: null,
        hasMore: false,
      },
    ];
    deliver.listWaitCandidates.mockImplementation(
      ({ afterId }: { afterId?: string }) =>
        Effect.succeed(currentSnapshotPages[afterId ? 1 : 0]!)
    );
    const deliveredCandidateIds: string[][] = [];
    let candidatePagesBeforeFirstDelivery = 0;
    deliver.deliverWaitCandidates.mockImplementation(
      ({ candidates }: { candidates: (typeof originalCandidate)[] }) => {
        candidatePagesBeforeFirstDelivery ||=
          deliver.listWaitCandidates.mock.calls.length;
        deliveredCandidateIds.push(candidates.map((candidate) => candidate.id));
        return deliveredCandidateIds.length === 1
          ? Effect.fail(
              new DatabaseError({
                cause: new Error("connection reset during wait claim"),
              })
            )
          : Effect.succeed({ workflowId: "wf_1", resumedWaits: 1 });
      }
    );
    const recorder = memoizedStep();
    const input = {
      event: appointmentCreated,
      payload,
      arrival: { eventId: "evt_early" },
      runtime: testRuntime(),
      step: recorder.step,
      deliver,
    };

    await expect(runEventListener(input)).rejects.toBeInstanceOf(DatabaseError);

    // The original Wait's action parks a second Wait before Inngest retries
    // this delivery step. The saved step result keeps the later row outside
    // this Event's candidate set.
    currentSnapshotPages[1] = {
      candidates: [otherOriginalCandidate, laterCandidate],
      afterId: null,
      hasMore: false,
    };

    const result = await runEventListener(input);

    expect(candidatePagesBeforeFirstDelivery).toBe(2);
    expect(deliver.listWaitCandidates).toHaveBeenCalledTimes(2);
    expect(deliveredCandidateIds).toEqual([
      ["wait_original"],
      ["wait_original"],
      ["wait_other"],
    ]);
    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "wait-candidates-wf_1-0",
      "wait-candidates-wf_1-1",
      "waits-wf_1-0",
      "subscribers-app/appointment.created",
      "wait-candidates-wf_1-0",
      "wait-candidates-wf_1-1",
      "waits-wf_1-0",
      "waits-wf_1-1",
    ]);
    expect(result.workflows).toEqual([
      {
        lifecycle: { kind: "waits_only", workflowId: "wf_1" },
        resumedWaits: 2,
      },
    ]);
  });

  it("delivers no waits to a workflow that is gone", async () => {
    const deliver = fakeDeliver();
    deliver.listSubscribers.mockReturnValue(Effect.succeed([subscriber()]));
    deliver.applyLifecycle.mockReturnValue(
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
      deliver,
    });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "lifecycle-wf_1",
    ]);
    expect(deliver.listWaitCandidates.mock.calls).toHaveLength(0);
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
        deliver: fakeDeliver(),
      })
    ).rejects.toThrow(/Payload refused for Event/);

    expect(recorder.ids).toEqual([]);
  });

  // A rejected query is the one thing here worth retrying, so it leaves the
  // handler as itself.
  it("lets a refused query out to the retry policy", async () => {
    const deliver = fakeDeliver();
    deliver.listSubscribers.mockReturnValue(
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
      deliver,
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(DatabaseError);
  });
});

describe("createInngestEventListenerFunction", () => {
  const client = new Inngest({ id: "listener-test", isDev: true });

  type BuiltOptions = {
    opts: {
      triggers: { event: string; if?: string }[];
      throttle?: { key?: string } | undefined;
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
      connectionStamped: false,
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
