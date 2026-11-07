/**
 * Task check for the wfgraph-core/cloudflare-worker skill, the part Node can
 * run. Running workerd and Hyperdrive is out of scope, so these cases check
 * three things:
 *
 * - The documented Worker entry (`worker-entry.ts`) loads and exports the
 *   three handlers Cloudflare calls.
 * - `wfWorker` refuses the settings the skill warns about before it opens
 *   persistence.
 * - Which handlers a deployment wires decides whether runs advance. A SQLite
 *   file stands in for Hyperdrive, since a tick's claims and parks are the
 *   same contract on both, and `invokePlatform` stands in for Cloudflare: it
 *   delivers pending Queue messages to the `queue` handler and fires the
 *   Cron Trigger, each only when the deployment configures it.
 *
 * `expectRunsAdvance` is the grader. It passes for a deployment with a Cron
 * Trigger, with or without a Queue, and rejects the two the skill warns about:
 * a Queue with no Cron Trigger, and neither.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { defineEvent, type WfGraphPersistence } from "@wfgraph/core";
import {
  trustWfGraphUpstream,
  wfWorker,
  type WfGraphWakeMessage,
  type WfGraphWorker,
} from "@wfgraph/core/worker";
import { wfSqlite } from "@wfgraph/core/sqlite";
import { ENCRYPTION, RECORD_ACTION_ID, recordAction } from "#src/skills/host";
import documentedWorker from "#src/skills/cloudflare-worker/worker-entry";

const EVENTS_KEY = "events-key-for-the-skill-check";
const APPOINTMENT_CREATED = "clinic/appointment.created";

const appointmentCreated = defineEvent({
  name: APPOINTMENT_CREATED,
  schema: Schema.toStandardJSONSchemaV1(
    Schema.toStandardSchemaV1(Schema.Struct({ appointmentId: Schema.String }))
  ),
  correlationPath: "appointmentId",
});

/**
 * A stand-in for Cloudflare's `ExecutionContext`: `fetch` hands it the
 * invocation's closes, and `settled` waits for them the way the platform
 * keeps the invocation alive.
 */
function executionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    context: {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    },
    settled: async () => void (await Promise.all(pending)),
  };
}

/** The Queue producer binding: it holds each message until the platform delivers it. */
function wakeQueue() {
  const pending: WfGraphWakeMessage[] = [];
  return {
    pending,
    send: (message: WfGraphWakeMessage) => {
      pending.push(message);
      return Promise.resolve();
    },
  };
}

type Deployment = { cron: boolean; queue: boolean };
type TestEnv = Record<string, never>;

/**
 * What Cloudflare does for the deployment in one minute: hand every pending
 * Queue message to the `queue` handler when the Worker consumes the Queue,
 * then fire the Cron Trigger when one is configured.
 */
async function invokePlatform(
  worker: WfGraphWorker<TestEnv>,
  queue: ReturnType<typeof wakeQueue>,
  deployment: Deployment
): Promise<void> {
  if (deployment.queue && queue.pending.length > 0) {
    await worker.queue({ messages: queue.pending.splice(0) }, {});
  }
  if (deployment.cron) {
    await worker.scheduled({ cron: "* * * * *" }, {});
  }
}

/** Sends one request to the Worker's `fetch` and waits for its closes. */
async function workerRequest(
  worker: WfGraphWorker<TestEnv>,
  input: {
    method: "GET" | "POST";
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  }
): Promise<Response> {
  const { context, settled } = executionContext();
  const response = await worker.fetch(
    new Request(`https://workflows.example.com${input.path}`, {
      method: input.method,
      headers: { "content-type": "application/json", ...input.headers },
      body: input.body === undefined ? null : JSON.stringify(input.body),
    }),
    {},
    context
  );
  await settled();
  return response;
}

/** One node of the serialized graph the workflow REST routes accept. */
function graphNode(id: string, type: string, config: Record<string, unknown>) {
  return {
    key: id,
    attributes: {
      id,
      type,
      position: { x: 0, y: 0 },
      data: { id, type, label: id, config },
    },
  };
}

function graphEdge(
  source: string,
  target: string,
  sourceHandle: string | null
) {
  const id = `${source}_${target}`;
  return {
    key: id,
    source,
    target,
    attributes: { id, source, target, sourceHandle, targetHandle: null },
  };
}

/**
 * A workflow an appointment Event starts. It waits one second, which parks
 * the run with a deadline only a later tick can find, then runs one step.
 */
const waitingWorkflow = {
  nodes: [
    graphNode("entry", "lifecycle", {
      lifecycleRules: {
        startEvents: [APPOINTMENT_CREATED],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: false,
      },
    }),
    graphNode("pause", "action", {
      actionType: "Wait",
      waitMode: "delay",
      waitDuration: "1s",
      waitGateMode: "require_actual_wait",
    }),
    graphNode("record", "action", {
      actionType: RECORD_ACTION_ID,
      marker: "after-wait",
    }),
  ],
  edges: [
    graphEdge("entry", "pause", "started"),
    graphEdge("pause", "record", null),
  ],
};

const created = Schema.Struct({
  id: Schema.String,
  draftRevision: Schema.Number,
});
const runList = Schema.Struct({
  items: Schema.Array(Schema.Struct({ status: Schema.String })),
});

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "wfgraph-skill-worker-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/**
 * The grader. It publishes `waitingWorkflow` through the Worker, posts the
 * Event that starts it, lets the platform run one minute, waits out the
 * Wait's deadline, lets the platform run another minute, and asserts that the
 * run completed.
 */
async function expectRunsAdvance(deployment: Deployment): Promise<void> {
  const queue = wakeQueue();
  // A file, because every invocation opens and closes its own connection,
  // as each Worker invocation does with Hyperdrive.
  const persistence = wfSqlite({ filename: join(directory, "worker.sqlite") });
  const worker = wfWorker<TestEnv>({
    extensions: { events: [appointmentCreated], actions: [recordAction] },
    request: () => ({
      auth: trustWfGraphUpstream(),
      persistence,
      encryption: ENCRYPTION,
      events: { key: EVENTS_KEY },
      wakeQueue: deployment.queue ? queue : undefined,
    }),
  });

  const createResponse = await workerRequest(worker, {
    method: "POST",
    path: "/api/rest/workflows/create",
    body: { name: "Reminder", graph: waitingWorkflow },
  });
  const workflow = Schema.decodeUnknownSync(created)(
    await createResponse.json()
  );
  const published = await workerRequest(worker, {
    method: "POST",
    path: `/api/rest/workflows/${workflow.id}/publish`,
    body: {
      graph: waitingWorkflow,
      expectedDraftRevision: workflow.draftRevision,
      expectedPublishedVersionId: null,
    },
  });
  expect(published.status).toBe(200);

  const sent = await workerRequest(worker, {
    method: "POST",
    path: "/api/events",
    headers: { authorization: `Bearer ${EVENTS_KEY}` },
    body: { name: APPOINTMENT_CREATED, data: { appointmentId: "appt_1" } },
  });
  expect(sent.status).toBe(202);

  await invokePlatform(worker, queue, deployment);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await invokePlatform(worker, queue, deployment);

  const runs = await workerRequest(worker, {
    method: "GET",
    path: `/api/rest/workflows/${workflow.id}/executions`,
  });
  const { items } = Schema.decodeUnknownSync(runList)(await runs.json());
  expect(
    items.map((item) => item.status),
    "the run did not complete"
  ).toEqual(["completed"]);
}

describe("wfgraph-core/cloudflare-worker task check", () => {
  it("loads the documented Worker entry with its fetch, scheduled and queue handlers", () => {
    expect(documentedWorker.fetch).toBeTypeOf("function");
    expect(documentedWorker.scheduled).toBeTypeOf("function");
    expect(documentedWorker.queue).toBeTypeOf("function");
  });

  // A type-level check: `pnpm run type-check` fails if wfWorker ever accepts
  // the worker loop settings `createWfGraphApp` takes, because the directive
  // would then have no error to expect.
  it("takes no runner option, since a Worker advances runs in ticks", () => {
    const worker = wfWorker<TestEnv>({
      // @ts-expect-error -- wfWorker has no `runner` option.
      runner: { concurrency: 4 },
      request: () => {
        throw new Error("never called");
      },
    });
    expect(worker.scheduled).toBeTypeOf("function");
  });

  it("refuses a publicUrl that carries the mount path, when the Worker starts", () => {
    expect(() =>
      wfWorker({
        publicUrl: "https://example.com/workflows",
        request: () => {
          throw new Error("never called");
        },
      })
    ).toThrow("Put the mount path in basePath");
  });

  it("refuses a bad encryption key or a blank events key before it opens persistence", async () => {
    let opened = 0;
    const persistence: WfGraphPersistence = {
      open: () => {
        opened += 1;
        return Promise.reject(new Error("persistence should stay closed"));
      },
    };
    const worker = (config: { key: string; eventsKey?: string }) =>
      wfWorker<TestEnv>({
        request: () => ({
          auth: trustWfGraphUpstream(),
          persistence,
          encryption: { key: config.key },
          events: { key: config.eventsKey },
        }),
      });

    await expect(
      workerRequest(worker({ key: "too-short" }), {
        method: "GET",
        path: "/api/extensions",
      })
    ).rejects.toThrow();
    await expect(
      workerRequest(worker({ key: ENCRYPTION.key, eventsKey: " " }), {
        method: "GET",
        path: "/api/extensions",
      })
    ).rejects.toThrow("events.key is blank");
    await expect(
      worker({ key: "too-short" }).scheduled({ cron: "* * * * *" }, {})
    ).rejects.toThrow();
    expect(opened).toBe(0);
  });

  it("advances runs on a deployment with a Cron Trigger and no Queue", async () => {
    await expectRunsAdvance({ cron: true, queue: false });
  });

  it("advances runs on a deployment with a Cron Trigger and a wake Queue", async () => {
    await expectRunsAdvance({ cron: true, queue: true });
  });

  // The mistake the skill warns about most: a Queue in place of the Cron
  // Trigger. The Queue delivers the Event and the run parks at its Wait, but
  // nothing sends a message when the deadline passes, so the run never resumes.
  it("rejects a deployment with a wake Queue and no Cron Trigger", async () => {
    // The run started and is still parked at its Wait.
    await expect(
      expectRunsAdvance({ cron: false, queue: true })
    ).rejects.toThrow(
      "the run did not complete: expected [ 'waiting' ] to deeply equal [ 'completed' ]"
    );
  });

  // Without either, nothing ever delivers the Event, so no run opens at all.
  it("rejects a deployment with neither a Cron Trigger nor a Queue", async () => {
    await expect(
      expectRunsAdvance({ cron: false, queue: false })
    ).rejects.toThrow(
      "the run did not complete: expected [] to deeply equal [ 'completed' ]"
    );
  });
});
