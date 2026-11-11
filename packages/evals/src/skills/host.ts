/**
 * The host application the skill task checks run against: `createWfGraphApp`
 * on in-memory SQLite with one host action, driven over the REST API the way
 * an operator's editor or script would drive it. A check asserts only what an
 * adopter can observe from outside the app: HTTP statuses, trace spans and log
 * records. Each case opens its own app and disposes it.
 */

import { Schema } from "effect";
import {
  createWfGraphApp,
  defineAction,
  type WfGraphApp,
  type WfGraphAppOptions,
} from "@wfgraph/core";
import { wfSqlite } from "@wfgraph/core/sqlite";

/** A valid 64-character hex key; the checks store no real credential. */
export const ENCRYPTION = { key: "e".repeat(64) };

/** The id of the host action every check's workflow runs. */
export const RECORD_ACTION_ID = "skillcheck/record";

const markerSchema = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(Schema.Struct({ marker: Schema.String }))
);

/** A host action that answers its input, so a run has one step to execute. */
export const recordAction = defineAction({
  id: RECORD_ACTION_ID,
  label: "Record",
  description: "Answers the marker it was given",
  input: markerSchema,
  output: markerSchema,
  handler: async ({ input }) => await Promise.resolve({ marker: input.marker }),
});

/**
 * Opens an app on in-memory SQLite with `recordAction` in its extensions. The
 * app runs its own worker loop, so a run started over HTTP advances without
 * anything else in the process.
 */
export async function openHost(
  options: Pick<WfGraphAppOptions, "auth"> &
    Partial<Pick<WfGraphAppOptions, "logger" | "mcp" | "agent">>
): Promise<WfGraphApp> {
  return await createWfGraphApp({
    persistence: wfSqlite(),
    encryption: ENCRYPTION,
    extensions: { actions: [recordAction] },
    ...options,
  });
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

/**
 * A workflow an operator starts by hand: a Lifecycle Node that allows a
 * manual start, followed by one `recordAction` step.
 */
export function manualStartGraph() {
  return {
    nodes: [
      graphNode("entry", "lifecycle", {
        lifecycleRules: {
          startEvents: [],
          cancelEvents: [],
          concurrency: "unlimited",
          allowManualStart: true,
        },
      }),
      graphNode("record", "action", {
        actionType: RECORD_ACTION_ID,
        marker: "ran",
      }),
    ],
    edges: [
      {
        key: "entry_record",
        source: "entry",
        target: "record",
        attributes: {
          id: "entry_record",
          source: "entry",
          target: "record",
          sourceHandle: "started",
          targetHandle: null,
        },
      },
    ],
  };
}

/**
 * Sends one request to the app's REST API, at `/api/rest` under the default
 * mount. `headers` carries whatever the host's `auth` callback reads, such as
 * a session cookie.
 */
export async function rest(
  app: WfGraphApp,
  input: {
    method: "GET" | "POST";
    path: `/${string}`;
    headers?: Record<string, string> | undefined;
    body?: unknown;
  }
): Promise<Response> {
  return await app.fetch(
    new Request(`http://localhost/api/rest${input.path}`, {
      method: input.method,
      headers: { "content-type": "application/json", ...input.headers },
      body: input.body === undefined ? null : JSON.stringify(input.body),
    })
  );
}

const createdWorkflow = Schema.Struct({
  id: Schema.String,
  draftRevision: Schema.Number,
});

/** A workflow `createWorkflow` made, with what a publish of it must name. */
export type CreatedWorkflow = typeof createdWorkflow.Type;

/** Creates a draft of `manualStartGraph` and answers its id and revision. */
export async function createWorkflow(
  app: WfGraphApp,
  headers?: Record<string, string>
): Promise<CreatedWorkflow> {
  const response = await rest(app, {
    method: "POST",
    path: "/workflows/create",
    headers,
    body: { name: "Skill check", graph: manualStartGraph() },
  });
  if (!response.ok) {
    throw new Error(`Creating the workflow answered ${response.status}`);
  }
  return Schema.decodeUnknownSync(createdWorkflow)(await response.json());
}

/** Publishes the draft `createWorkflow` made, answering the raw response. */
export async function publishWorkflow(
  app: WfGraphApp,
  workflow: CreatedWorkflow,
  headers?: Record<string, string>
): Promise<Response> {
  return await rest(app, {
    method: "POST",
    path: `/workflows/${workflow.id}/publish`,
    headers,
    body: {
      graph: manualStartGraph(),
      expectedDraftRevision: workflow.draftRevision,
      expectedPublishedVersionId: null,
    },
  });
}

const startedRun = Schema.Struct({
  status: Schema.Literal("running"),
  executionId: Schema.String,
});

const runList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ id: Schema.String, status: Schema.String })
  ),
});

/** The ids of one workflow run `runPublishedWorkflow` started and finished. */
export type FinishedRun = { workflowId: string; executionId: string };

/**
 * Creates and publishes `manualStartGraph`, starts it by hand over REST, and
 * waits until the app's worker loop reports the run completed.
 */
export async function runPublishedWorkflow(
  app: WfGraphApp
): Promise<FinishedRun> {
  const workflow = await createWorkflow(app);
  const published = await publishWorkflow(app, workflow);
  if (!published.ok) {
    throw new Error(`Publishing the workflow answered ${published.status}`);
  }
  const started = await rest(app, {
    method: "POST",
    path: `/workflow/${workflow.id}/execute`,
    body: {},
  });
  const { executionId } = Schema.decodeUnknownSync(startedRun)(
    await started.json()
  );
  await waitFor(async () => {
    const response = await rest(app, {
      method: "GET",
      path: `/workflows/${workflow.id}/executions`,
    });
    const { items } = Schema.decodeUnknownSync(runList)(await response.json());
    return items.some(
      (item) => item.id === executionId && item.status === "completed"
    );
  });
  return { workflowId: workflow.id, executionId };
}

/** Polls `done` every 20 ms for up to five seconds. */
async function waitFor(done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line eslint/no-await-in-loop -- each poll waits on the last
    if (await done()) return;
    // eslint-disable-next-line eslint/no-await-in-loop -- each poll waits on the last
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The workflow run did not complete within five seconds");
}
