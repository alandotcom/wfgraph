/**
 * `app.workflows.readDraftNode` wired into a real app: a draft saved through
 * the REST API on SQLite and read back, and the rejections a host sees after
 * dispose and when storage refuses the read. `draft-node.test.ts` covers what
 * the answer holds.
 */

import { expect, it } from "vitest";
import { z } from "zod";
import {
  createWfGraphApp,
  defineAction,
  trustWfGraphUpstream,
} from "#src/index";
import { wfSqlite } from "#src/sqlite";
import { BASE_OPTIONS } from "#src/app-test-support";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";

const sendEmail = defineAction({
  id: "donors/send-email",
  label: "Send Email to Donor",
  description: "Sends an email to a donor.",
  input: z.object({ subject: z.string() }),
  handler: () => ({}),
});

it("reads a node of the draft saved through the API", async () => {
  await using app = await createWfGraphApp({
    auth: trustWfGraphUpstream(),
    persistence: wfSqlite(),
    extensions: { actions: [sendEmail] },
  });

  const graph = createSerializedWorkflowGraph({
    nodes: [
      {
        id: "entry",
        type: "lifecycle",
        position: { x: 0, y: -160 },
        data: {
          label: "Donors",
          type: "lifecycle",
          config: {
            lifecycleRules: {
              startEvents: [],
              cancelEvents: [],
              concurrency: "unlimited",
              allowManualStart: true,
            },
          },
        },
      },
      {
        id: "send",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Welcome email",
          type: "action",
          config: { actionType: "donors/send-email", subject: "Welcome" },
        },
      },
    ],
    edges: [
      {
        id: "entry->send",
        source: "entry",
        target: "send",
        sourceHandle: "started",
      },
    ],
  });
  const response = await app.fetch(
    new Request("http://localhost/api/rest/workflows/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Donor welcome", graph }),
    })
  );
  expect(response.ok).toBe(true);
  const created = (await response.json()) as {
    id: string;
    draftRevision: number;
  };

  await expect(
    app.workflows.readDraftNode({ workflowId: created.id, nodeId: "send" })
  ).resolves.toEqual({
    workflowId: created.id,
    nodeId: "send",
    label: "Welcome email",
    actionId: "donors/send-email",
    revision: created.draftRevision,
    fields: {
      subject: {
        kind: "template",
        segments: [{ kind: "text", text: "Welcome" }],
      },
    },
  });
  await expect(
    app.workflows.readDraftNode({ workflowId: "missing", nodeId: "send" })
  ).resolves.toBeNull();
});

// A read the runtime cannot run any more is a failure the host can catch like
// any storage failure: an Error with a sentence and the reason as cause.
it("rejects a read after dispose with an Error carrying the cause", async () => {
  const app = await createWfGraphApp({
    auth: trustWfGraphUpstream(),
    persistence: wfSqlite(),
  });
  await app.dispose();

  const rejection = await app.workflows
    .readDraftNode({ workflowId: "wf_1", nodeId: "send" })
    .then(
      () => undefined,
      (error: unknown) => error
    );

  expect(rejection).toBeInstanceOf(Error);
  expect(rejection).toMatchObject({ message: "Could not read the draft node" });
  expect(rejection instanceof Error && rejection.cause).toBeDefined();
});

// BASE_OPTIONS names a PostgreSQL server on a port nothing listens on, and an
// app with no worker loop opens no connection until the read asks for one.
it("rejects a read storage refuses with the failure as cause", async () => {
  await using app = await createWfGraphApp({ ...BASE_OPTIONS, runner: false });

  const rejection = await app.workflows
    .readDraftNode({ workflowId: "wf_1", nodeId: "send" })
    .then(
      () => undefined,
      (error: unknown) => error
    );

  expect(rejection).toBeInstanceOf(Error);
  expect(rejection).toMatchObject({ message: "Failed to read the draft node" });
  expect(rejection instanceof Error && rejection.cause).toBeDefined();
});
