/**
 * The tools that read a workflow's runs, start a test run, and look up the
 * choices a provider-backed field offers. Each one asks `WorkflowOperations`,
 * which the host implements and gates on the caller's grants.
 */

import { Context, Effect, Schema } from "effect";
import { Tool } from "effect/ai";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { WorkflowDraft } from "#src/document";
import { WorkflowOperations } from "#src/operations";
import { readHints } from "#src/tools/tool-hints";

const failureSchema = Schema.Struct({ reason: Schema.String });

/** The most runs one list_runs call answers. */
const MAX_LISTED_RUNS = 20;

/**
 * The host builds these values in process and may set an optional key to
 * `undefined`, so the optional fields are `Schema.optional`.
 */
const runSummaryFields = {
  runId: Schema.String,
  status: Schema.String,
  runMode: Schema.String,
  startSource: Schema.String,
  startEventName: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  startedAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
};

export const ListRuns = Tool.make("list_runs", {
  description: `List this workflow's most recent runs, newest first: status, whether it was a test run, how it started, and its error. At most ${MAX_LISTED_RUNS}. An empty list means the workflow has never run.`,
  parameters: Schema.Struct({
    limit: Schema.optionalKey(
      Schema.Finite.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: MAX_LISTED_RUNS })
      )
    ).annotate({
      description: `How many runs to answer, 1 to ${MAX_LISTED_RUNS}. Defaults to 10.`,
    }),
  }),
  success: Schema.Struct({
    runs: Schema.Array(Schema.Struct(runSummaryFields)),
    total: Schema.Number,
  }),
  failure: failureSchema,
  failureMode: "return",
}).annotateMerge(readHints("List runs"));

export const ReadRun = Tool.make("read_run", {
  description:
    "Read one run of this workflow: its status and error, and each step it reached with that step's status, error, and output (cut to a bounded length; outputBytes gives the full size). Omit runId to read the most recent run. Read the run before explaining why it failed.",
  parameters: Schema.Struct({
    runId: Schema.optionalKey(Schema.String).annotate({
      description: "A runId from list_runs. Omit for the most recent run.",
    }),
  }),
  success: Schema.Struct({
    ...runSummaryFields,
    steps: Schema.Array(
      Schema.Struct({
        nodeId: Schema.String,
        nodeName: Schema.String,
        status: Schema.String,
        error: Schema.optional(Schema.String),
        outputBytes: Schema.Number,
        output: Schema.optional(Schema.String),
        startedAt: Schema.String,
        durationMs: Schema.optional(Schema.Number),
      })
    ),
    waitingAt: Schema.Array(
      Schema.Struct({ nodeId: Schema.String, nodeName: Schema.String })
    ),
  }),
  failure: failureSchema,
  failureMode: "return",
}).annotateMerge(readHints("Read a run"));

export const StartTestRun = Tool.make("start_test_run", {
  description:
    "Start a Draft run of the saved draft with a payload, and answer its runId for read_run. A Draft run calls the real action handlers in test mode: integrations send to their test recipients, and a host action runs as written. Start one only when the person asks for a test run.",
  parameters: Schema.Struct({
    payload: Schema.String.annotate({
      description:
        'The Start Event payload as JSON object text, shaped as describe_event describes it, such as {"applicantId":"a_1"}. "{}" for a workflow started by hand.',
    }),
    eventName: Schema.optionalKey(Schema.String).annotate({
      description:
        "The Start Event this run stands in for, from list_events. Omit for a manual start.",
    }),
  }),
  success: Schema.Struct({
    status: Schema.Literals(["started", "ignored"]),
    runId: Schema.optionalKey(Schema.String),
    reason: Schema.optionalKey(Schema.String),
  }),
  failure: failureSchema,
  failureMode: "return",
}).annotateMerge(
  Context.make(Tool.Title, "Start a test run").pipe(
    Context.add(Tool.Readonly, false),
    Context.add(Tool.Destructive, true),
    Context.add(Tool.Idempotent, false),
    Context.add(Tool.OpenWorld, true)
  )
);

export const ListFieldOptions = Tool.make("list_field_options", {
  description:
    "Look up the choices a provider-backed config field offers, such as the values a host picker lists. Only a field describe_action marks with an options provider has choices; pass the step's integrationId for an integration action.",
  parameters: Schema.Struct({
    actionId: Schema.String.annotate({
      description: "The action id from list_actions.",
    }),
    fieldKey: Schema.String.annotate({
      description: "The config key from describe_action.",
    }),
    integrationId: Schema.optionalKey(Schema.String).annotate({
      description:
        "The connectionId from list_integrations, for an integration action.",
    }),
    parameters: Schema.optionalKey(
      Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))
    ).annotate({
      description:
        "Other literal config values of the step the provider reads, as key and value pairs.",
    }),
  }),
  success: Schema.Struct({
    options: Schema.Array(
      Schema.Struct({ value: Schema.String, label: Schema.String })
    ),
    unavailable: Schema.optionalKey(Schema.String),
  }),
  failure: failureSchema,
  failureMode: "return",
}).annotateMerge(readHints("List field choices"));

/** The value JSON text holds, or undefined for text that is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const runToolHandlers = Effect.gen(function* () {
  const operations = yield* WorkflowOperations;
  const draft = yield* WorkflowDraft;

  return {
    list_runs: (input: { readonly limit?: number | undefined }) =>
      Effect.map(operations.listRuns({ limit: input.limit ?? 10 }), (page) => ({
        runs: [...page.runs],
        total: page.total,
      })),

    read_run: (input: { readonly runId?: string | undefined }) =>
      Effect.gen(function* () {
        const runId =
          input.runId ??
          (yield* operations.listRuns({ limit: 1 })).runs[0]?.runId;
        if (runId === undefined) {
          return yield* Effect.fail({
            reason:
              "This workflow has never run, so there is no run to read. Say so rather than guessing why it would fail.",
          });
        }
        return yield* operations.readRun({ runId });
      }),

    start_test_run: (input: {
      readonly payload: string;
      readonly eventName?: string | undefined;
    }) =>
      Effect.gen(function* () {
        // A test run reads the stored draft. Edits made earlier in the same
        // session are stored only when the session ends (a chat turn is saved
        // by the editor), so a run started now would test the graph before them.
        if ((yield* draft.latest).revision > 0) {
          return yield* Effect.fail({
            reason:
              "This session already edited the draft, and a test run reads the saved draft, which does not hold those edits yet. Finish the edits and start the test run in a later turn.",
          });
        }
        const payload = readJsonObject(parseJson(input.payload));
        if (payload === null) {
          return yield* Effect.fail({
            reason:
              'payload must be the text of one JSON object, such as {} or {"applicantId":"a_1"}.',
          });
        }
        const started = yield* operations.startTestRun({
          payload,
          eventName: input.eventName,
        });
        return started.status === "started"
          ? { status: started.status, runId: started.runId }
          : { status: started.status, reason: started.reason };
      }),

    list_field_options: (input: {
      readonly actionId: string;
      readonly fieldKey: string;
      readonly integrationId?: string | undefined;
      readonly parameters?:
        | readonly { readonly key: string; readonly value: string }[]
        | undefined;
    }) =>
      Effect.map(
        operations.fieldOptions({
          actionId: input.actionId,
          fieldKey: input.fieldKey,
          integrationId: input.integrationId,
          parameters: Object.fromEntries(
            (input.parameters ?? []).map((entry) => [entry.key, entry.value])
          ),
        }),
        (answer) =>
          answer.status === "options"
            ? { options: [...answer.options] }
            : { options: [], unavailable: answer.message }
      ),
  };
});
