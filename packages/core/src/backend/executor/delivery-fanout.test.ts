import { Effect, Layer, Schema, SchemaTransformation } from "effect";
import { describe, expect, it, vi } from "vitest";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  SilentAppLoggerLayer,
  stubExecutionDriver,
  stubExecutionRepo,
  stubExtensions,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { defineEvent } from "#src/backend/extensions/define-event";
import {
  type DecodedArrival,
  type DeliveryFanOutPorts,
  DeliveryStepsPending,
  fanOutDelivery,
} from "#src/backend/executor/delivery-fanout";
import type { PassSteps } from "#src/backend/executor/runtime";
import type { WaitCandidatePage } from "#src/backend/services/workflows/lifecycle/deliver-event";
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

/** An arrival of `appointmentCreated` carrying `payload`. */
const created: DecodedArrival = {
  event: appointmentCreated,
  payload,
  validated: payload,
};

/** The steps a delivery took, in the order it took them. */
function recordingStep(): { ids: string[]; steps: PassSteps } {
  const ids: string[] = [];
  return {
    ids,
    steps: {
      run: (id, step) =>
        Effect.sync(() => ids.push(id)).pipe(Effect.andThen(step)),
    },
  };
}

/** A small stand-in for the step memo answering a step that succeeded, on retry. */
function memoizedStep(): { ids: string[]; steps: PassSteps } {
  const ids: string[] = [];
  const outputs = new Map<string, unknown>();
  return {
    ids,
    steps: {
      run: <A, E, R>(id: string, step: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => {
          ids.push(id);
          if (outputs.has(id)) {
            return Effect.succeed(outputs.get(id) as A);
          }
          return step.pipe(
            Effect.tap((output) => Effect.sync(() => outputs.set(id, output)))
          );
        }),
    },
  };
}

/**
 * Runs one fan-out. The ports it is handed are fakes, so the services its
 * type names are stubs that die if anything reaches them.
 */
function runFanOut(
  input: Omit<
    Parameters<typeof fanOutDelivery>[0],
    "connectionId" | "attempt"
  > & { attempt?: number }
) {
  return Effect.runPromise(
    fanOutDelivery({ connectionId: null, attempt: 0, ...input }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SilentAppLoggerLayer,
          stubWorkflowRepo(),
          stubExecutionRepo(),
          stubIntegrationRepo(),
          stubExtensions(),
          stubExecutionDriver()
        )
      )
    )
  );
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
 * so the halves themselves are fakes passed as the fan-out's ports;
 * `deliver-event.test.ts` covers what each one does.
 */
function fakeDeliver(): DeliveryFanOutPorts & {
  applyLifecycle: ReturnType<typeof vi.fn>;
  listWaitCandidates: ReturnType<typeof vi.fn>;
  deliverWaitCandidates: ReturnType<typeof vi.fn>;
  listSubscribers: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
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
  const recordFailure = vi.fn(() => Effect.void);
  return {
    listSubscribers,
    applyLifecycle,
    listWaitCandidates,
    deliverWaitCandidates,
    recordFailure,
  };
}

/**
 * The workflow each call of a fake port named, in call order: its subscriber's
 * id for the lifecycle port, and its `workflowId` for a wait port.
 */
function workflowIdsOf(port: ReturnType<typeof vi.fn>): unknown[] {
  return port.mock.calls.map(
    ([call]) => call?.subscriber?.id ?? call?.workflowId
  );
}

describe("fanOutDelivery", () => {
  // An inbox row names one arrival in both halves, so the lifecycle's committed
  // decision and every wake carry the same id.
  it("keys the lifecycle decision and the wakes of an inbox arrival by the inbox id", async () => {
    const deliver = fakeDeliver();
    deliver.listSubscribers.mockReturnValue(
      Effect.succeed([subscriber({ roles: ["start", "wait"] })])
    );

    await runFanOut({
      arrival: created,
      inboxId: "inbox_1",
      steps: recordingStep().steps,
      ports: deliver,
    });

    expect(deliver.applyLifecycle.mock.calls[0]?.[0].deliveryId).toBe(
      "inbox_1"
    );
    expect(deliver.deliverWaitCandidates.mock.calls[0]?.[0].deliveryId).toBe(
      "inbox_1"
    );
  });

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
      })
    );
    const recorder = recordingStep();

    const result = await runFanOut({
      arrival: created,
      inboxId: "inbox_1",
      steps: recorder.steps,
      ports: deliver,
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
    expect(result).toEqual({
      workflows: 2,
      started: 2,
      canceled: 0,
      resumedWaits: 0,
      failures: [],
    });

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

    await runFanOut({
      arrival: {
        event: transformedEvent,
        payload: wirePayload,
        validated: { appointment: { id: "appt_1" } },
      },
      inboxId: "inbox_1",
      steps: recorder.steps,
      ports: deliver,
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

    await runFanOut({
      arrival: created,
      inboxId: "inbox_1",
      steps: recorder.steps,
      ports: deliver,
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

    await runFanOut({
      arrival: created,
      inboxId: "inbox_1",
      steps: recorder.steps,
      ports: deliver,
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

    const result = await runFanOut({
      arrival: created,
      inboxId: "inbox_1",
      steps: recorder.steps,
      ports: deliver,
    });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "lifecycle-wf_1",
    ]);
    expect(deliver.deliverWaitCandidates.mock.calls).toHaveLength(0);
    expect(result.resumedWaits).toBe(0);
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

    const result = await runFanOut({
      arrival: created,
      inboxId: "inbox_9",
      steps: recorder.steps,
      ports: deliver,
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
    expect(deliver.deliverWaitCandidates.mock.calls[0]?.[0].deliveryId).toBe(
      "inbox_9"
    );
    expect(result).toEqual({
      workflows: 1,
      started: 0,
      canceled: 0,
      resumedWaits: 1,
      failures: [],
    });

    // The arrival travels with the delivery, so the audit row a start or a
    // refusal writes names the arrival it answered.
    expect(deliver.applyLifecycle.mock.calls[0]?.[0].deliveryId).toBe(
      "inbox_9"
    );
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
      arrival: created,
      inboxId: "inbox_early",
      steps: recorder.steps,
      ports: deliver,
    };

    await expect(runFanOut(input)).rejects.toBeInstanceOf(DeliveryStepsPending);

    // The original Wait's action parks a second Wait before the delivery runs
    // this step again. The saved step result keeps the later row outside
    // this Event's candidate set.
    currentSnapshotPages[1] = {
      candidates: [otherOriginalCandidate, laterCandidate],
      afterId: null,
      hasMore: false,
    };

    const result = await runFanOut({ ...input, attempt: 1 });

    expect(candidatePagesBeforeFirstDelivery).toBe(2);
    expect(deliver.listWaitCandidates).toHaveBeenCalledTimes(2);
    // The page that failed is tried again under a new step id, and the page
    // the first pass delivered is answered from its memo row.
    expect(deliveredCandidateIds).toEqual([
      ["wait_original"],
      ["wait_other"],
      ["wait_original"],
    ]);
    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "wait-candidates-wf_1-0",
      "wait-candidates-wf_1-1",
      "waits-wf_1-0",
      "waits-wf_1-1",
      "subscribers-app/appointment.created",
      "wait-candidates-wf_1-0",
      "wait-candidates-wf_1-1",
      "waits-wf_1-0",
      "waits-wf_1-0-retry-1",
      "waits-wf_1-1",
    ]);
    expect(result).toEqual({
      workflows: 1,
      started: 0,
      canceled: 0,
      resumedWaits: 2,
      failures: [],
    });
  });

  // One workflow's failing Lifecycle Rules must not keep the Event from the
  // others: B's runs still owe their cancel, and C's parked runs their wake.
  it("delivers to every other workflow while one workflow's lifecycle step keeps failing", async () => {
    const deliver = fakeDeliver();
    deliver.listSubscribers.mockReturnValue(
      Effect.succeed([
        subscriber({ id: "wf_a", roles: ["start"] }),
        subscriber({ id: "wf_b", roles: ["cancel", "wait"] }),
        subscriber({ id: "wf_c", roles: ["wait"] }),
      ])
    );
    deliver.applyLifecycle.mockImplementation(
      ({ subscriber: target }: { subscriber: EventSubscriber }) =>
        target.id === "wf_a"
          ? Effect.fail(
              new DatabaseError({ cause: new Error("resolver timed out") })
            )
          : Effect.succeed({
              kind: "canceled",
              workflowId: target.id,
              canceledExecutionIds: ["exec_b"],
            })
    );
    deliver.deliverWaitCandidates.mockImplementation(
      ({ workflowId }: { workflowId: string }) =>
        Effect.succeed({ workflowId, resumedWaits: 1 })
    );
    const recorder = memoizedStep();
    const input = {
      arrival: created,
      inboxId: "inbox_1",
      steps: recorder.steps,
      ports: deliver,
    };

    // Every pass but the last leaves a retry to the release; the first one
    // has already delivered B and C.
    for (const attempt of [0, 1, 2, 3]) {
      await expect(runFanOut({ ...input, attempt })).rejects.toBeInstanceOf(
        DeliveryStepsPending
      );
      if (attempt === 0) {
        expect(workflowIdsOf(deliver.applyLifecycle)).toEqual(["wf_a", "wf_b"]);
        expect(workflowIdsOf(deliver.deliverWaitCandidates)).toEqual([
          "wf_b",
          "wf_c",
        ]);
      }
    }
    const result = await runFanOut({ ...input, attempt: 4 });

    expect(workflowIdsOf(deliver.applyLifecycle)).toEqual([
      "wf_a",
      "wf_b",
      "wf_a",
      "wf_a",
      "wf_a",
      "wf_a",
    ]);
    expect(deliver.deliverWaitCandidates).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      workflows: 3,
      started: 0,
      canceled: 1,
      resumedWaits: 2,
      failures: [
        { workflowId: "wf_a", stage: "lifecycle", error: expect.any(String) },
      ],
    });
    expect(result.failures[0]?.error).toMatch(/resolver timed out/);
    expect(deliver.recordFailure).toHaveBeenCalledTimes(1);
    expect(deliver.recordFailure.mock.calls[0]?.[0]).toMatchObject({
      subscriber: { id: "wf_a" },
      eventName: appointmentCreated.name,
      deliveryId: "inbox_1",
      stage: "lifecycle",
    });
  });

  it("tries a failed lifecycle step again on the next pass and settles once it succeeds", async () => {
    const deliver = fakeDeliver();
    deliver.listSubscribers.mockReturnValue(
      Effect.succeed([
        subscriber({ id: "wf_a", roles: ["start"] }),
        subscriber({ id: "wf_b", roles: ["start"] }),
      ])
    );
    let failuresLeft = 1;
    deliver.applyLifecycle.mockImplementation(
      ({ subscriber: target }: { subscriber: EventSubscriber }) =>
        Effect.suspend(() => {
          if (target.id === "wf_a" && failuresLeft > 0) {
            failuresLeft -= 1;
            return Effect.fail(
              new DatabaseError({ cause: new Error("connection reset") })
            );
          }
          return Effect.succeed({
            kind: "started",
            workflowId: target.id,
            executionId: `exec_${target.id}`,
            supersededExecutionIds: [],
          });
        })
    );
    const recorder = memoizedStep();
    const input = {
      arrival: created,
      inboxId: "inbox_1",
      steps: recorder.steps,
      ports: deliver,
    };

    await expect(runFanOut(input)).rejects.toBeInstanceOf(DeliveryStepsPending);
    const result = await runFanOut({ ...input, attempt: 1 });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "lifecycle-wf_a",
      "lifecycle-wf_b",
      "subscribers-app/appointment.created",
      "lifecycle-wf_a",
      "lifecycle-wf_a-retry-1",
      "lifecycle-wf_b",
    ]);
    expect(deliver.applyLifecycle).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      workflows: 2,
      started: 2,
      canceled: 0,
      resumedWaits: 0,
      failures: [],
    });
    expect(deliver.recordFailure).not.toHaveBeenCalled();
  });

  // The release would end the whole delivery failed on its next body failure,
  // so a step failing on the row's last retry is recorded for its workflow.
  it("records a workflow failed when a step fails on the delivery's last retry", async () => {
    const deliver = fakeDeliver();
    deliver.listSubscribers.mockReturnValue(
      Effect.succeed([subscriber({ id: "wf_a", roles: ["start"] })])
    );
    deliver.applyLifecycle.mockReturnValue(
      Effect.fail(new DatabaseError({ cause: new Error("connection reset") }))
    );

    const result = await runFanOut({
      arrival: created,
      inboxId: "inbox_1",
      steps: memoizedStep().steps,
      ports: deliver,
      attempt: 4,
    });

    expect(result.failures).toEqual([
      { workflowId: "wf_a", stage: "lifecycle", error: expect.any(String) },
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

    await runFanOut({
      arrival: created,
      inboxId: "inbox_1",
      steps: recorder.steps,
      ports: deliver,
    });

    expect(recorder.ids).toEqual([
      "subscribers-app/appointment.created",
      "lifecycle-wf_1",
    ]);
    expect(deliver.listWaitCandidates.mock.calls).toHaveLength(0);
  });

  // A rejected query is the one thing here worth retrying, so it leaves the
  // fan-out as itself.
  it("lets a refused query out to the retry policy", async () => {
    const deliver = fakeDeliver();
    deliver.listSubscribers.mockReturnValue(
      Effect.fail(
        new DatabaseError({
          cause: new Error("terminating connection due to crash"),
        })
      )
    );

    const failure = await runFanOut({
      arrival: created,
      inboxId: "inbox_1",
      steps: recordingStep().steps,
      ports: deliver,
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(DatabaseError);
  });
});
