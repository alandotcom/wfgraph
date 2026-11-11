/**
 * What a build tool asks of the workflow beyond its draft: its runs, a test
 * run of the saved draft, and the choices a provider-backed field offers.
 *
 * The host implements this over its own services and checks the caller's
 * grants in each method, so a tool never touches a database or a provider.
 * Where a session supplies no implementation, every method refuses with a
 * sentence the model can repeat, which is what a tool test and a host without
 * these services get.
 */

import { Context, Effect } from "effect";
import type { JsonObject } from "@wfgraph/shared/types/json";

/** Why an operation answered nothing, in a sentence the model can act on. */
export type OperationRefusal = { readonly reason: string };

export type RunSummary = {
  readonly runId: string;
  readonly status: string;
  /** "test" for a Draft run or a run in Test mode, "live" otherwise. */
  readonly runMode: string;
  readonly startSource: string;
  readonly startEventName?: string | undefined;
  readonly error?: string | undefined;
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
};

export type RunStep = {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly status: string;
  readonly error?: string | undefined;
  /** The size of the step's output as JSON, in bytes. */
  readonly outputBytes: number;
  /** The output as JSON, cut to a bounded length and marked when cut. */
  readonly output?: string | undefined;
  readonly startedAt: string;
  readonly durationMs?: number | undefined;
};

export type RunDetail = RunSummary & {
  readonly steps: readonly RunStep[];
  /** The steps the run is parked at, by id and name. */
  readonly waitingAt: readonly {
    readonly nodeId: string;
    readonly nodeName: string;
  }[];
};

export type StartedTestRun =
  | { readonly status: "started"; readonly runId: string }
  | { readonly status: "ignored"; readonly reason: string };

export type FieldOptions =
  | {
      readonly status: "options";
      readonly options: readonly {
        readonly value: string;
        readonly label: string;
      }[];
    }
  | { readonly status: "unavailable"; readonly message: string };

export type WorkflowOperationsService = {
  /** The workflow's runs, newest first, at most `limit` of them. */
  readonly listRuns: (input: {
    readonly limit: number;
  }) => Effect.Effect<
    { readonly runs: readonly RunSummary[]; readonly total: number },
    OperationRefusal
  >;
  /** One run of this workflow and the log of each step it reached. */
  readonly readRun: (input: {
    readonly runId: string;
  }) => Effect.Effect<RunDetail, OperationRefusal>;
  /** Starts a Draft run of the saved draft with this payload. */
  readonly startTestRun: (input: {
    readonly payload: JsonObject;
    readonly eventName?: string | undefined;
  }) => Effect.Effect<StartedTestRun, OperationRefusal>;
  /** The choices a provider-backed config field offers. */
  readonly fieldOptions: (input: {
    readonly actionId: string;
    readonly fieldKey: string;
    readonly integrationId?: string | undefined;
    readonly parameters: Readonly<Record<string, string>>;
  }) => Effect.Effect<FieldOptions, OperationRefusal>;
};

const unavailable = Effect.fail({
  reason:
    "Runs and field choices are not available in this session. Say so plainly rather than guessing what they would show.",
});

const unavailableWorkflowOperations: WorkflowOperationsService = {
  listRuns: () => unavailable,
  readRun: () => unavailable,
  startTestRun: () => unavailable,
  fieldOptions: () => unavailable,
};

/**
 * The operations a tool session supplies. A reference with a refusing
 * default, so a toolkit built over a draft alone still answers every tool.
 */
export const WorkflowOperations = Context.Reference<WorkflowOperationsService>(
  "@wfgraph/agent/WorkflowOperations",
  { defaultValue: () => unavailableWorkflowOperations }
);
