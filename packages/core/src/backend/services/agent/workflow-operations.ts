/**
 * The build tools' `WorkflowOperations` for one workflow and one caller, over
 * the services the editor's Runs view, Run button and field pickers use. Each
 * method first asks the caller's `auth` for the grant the same editor
 * operation needs, and answers a refusal sentence rather than a failure the
 * tool would have to translate.
 */

import { Context, Effect } from "effect";
import type {
  OperationRefusal,
  RunStep,
  StartedTestRun,
  WorkflowOperationsService,
} from "@wfgraph/agent/operations";
import {
  WfGraphOperations,
  type WfGraphOperation,
} from "@wfgraph/shared/authorization/operations";
import { findAction } from "@wfgraph/shared/extensions/catalog";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { Extensions } from "#src/backend/lib/effect/extensions";
import type { ServiceFailure } from "#src/backend/lib/effect/failures";
import type { AuthContext } from "#src/backend/lib/http/authorize";
import type { WfGraphServices } from "#src/backend/runtime";
import { postActionConfigOptions } from "#src/backend/services/actions/config-options";
import { getExecutionLogs } from "#src/backend/services/executions/logs";
import { getWorkflowExecutions } from "#src/backend/services/executions/list";
import { postIntegrationConfigOptions } from "#src/backend/services/integrations/config-options";
import { postWorkflowExecute } from "#src/backend/services/workflows/lifecycle/manual-start";

/** The most characters of one step's output a run read carries. */
export const RUN_STEP_OUTPUT_CHARS = 2000;

function refusal(reason: string): OperationRefusal {
  return { reason };
}

/** A step output as bounded JSON text, and its full size. */
export function boundedOutput(
  output: unknown
): Pick<RunStep, "output" | "outputBytes"> {
  if (output === null || output === undefined) {
    return { outputBytes: 0 };
  }
  const text = JSON.stringify(output);
  return {
    outputBytes: new TextEncoder().encode(text).length,
    output:
      text.length > RUN_STEP_OUTPUT_CHARS
        ? `${text.slice(0, RUN_STEP_OUTPUT_CHARS)}… (cut)`
        : text,
  };
}

/**
 * Builds the operations for `workflowId`, closed over the app's services so
 * each method's Effect requires nothing, as a tool handler's must.
 */
export const makeWorkflowOperations = Effect.fn("makeWorkflowOperations")(
  function* (input: {
    readonly workflowId: string;
    readonly auth: AuthContext;
  }) {
    const services = yield* Effect.context<WfGraphServices>();
    const { workflowId, auth } = input;

    /** Runs a service under the app's context, answering its failure as a sentence. */
    function serve<A>(
      operation: WfGraphOperation,
      effect: Effect.Effect<A, ServiceFailure, WfGraphServices>
    ): Effect.Effect<A, OperationRefusal> {
      return Effect.gen(function* () {
        const allowed = yield* Effect.promise(async () =>
          auth.allows(operation)
        );
        if (!allowed) {
          return yield* Effect.fail(
            refusal(
              `Forbidden: the caller lacks the grant for ${operation.id}. Say so rather than guessing the answer.`
            )
          );
        }
        return yield* Effect.provideContext(effect, services).pipe(
          Effect.mapError((failure) => refusal(failure.error))
        );
      });
    }

    const operations: WorkflowOperationsService = {
      listRuns: ({ limit }) =>
        serve(
          WfGraphOperations.workflowGetExecutions,
          getWorkflowExecutions({ workflowId, includeSuperseded: false })
        ).pipe(
          Effect.map((page) => ({
            total: page.items.length,
            runs: page.items.slice(0, limit).map((item) =>
              omitUndefined({
                runId: item.id,
                status: item.status,
                runMode: item.runMode,
                startSource: item.startSource ?? "unknown",
                startEventName: item.startEventName ?? undefined,
                error: item.error ?? undefined,
                startedAt: item.startedAt,
                completedAt: item.completedAt ?? undefined,
              })
            ),
          }))
        ),

      readRun: ({ runId }) =>
        serve(
          WfGraphOperations.workflowGetExecutionLogs,
          getExecutionLogs(runId)
        ).pipe(
          Effect.flatMap(({ execution, logs, waits }) =>
            execution.workflowId === workflowId
              ? Effect.succeed(
                  omitUndefined({
                    runId: execution.id,
                    status: execution.status,
                    runMode: execution.runMode,
                    startSource: execution.startSource,
                    startEventName: execution.startEventName ?? undefined,
                    error: execution.error ?? undefined,
                    startedAt: execution.startedAt,
                    completedAt: execution.completedAt ?? undefined,
                    steps: logs.map((log) =>
                      omitUndefined({
                        nodeId: log.nodeId,
                        nodeName: log.nodeName,
                        status: log.status,
                        error: log.error ?? undefined,
                        ...boundedOutput(log.output),
                        startedAt: log.startedAt,
                        durationMs:
                          log.duration === null
                            ? undefined
                            : Number(log.duration),
                      })
                    ),
                    waitingAt: waits.map((wait) => ({
                      nodeId: wait.nodeId,
                      nodeName: wait.nodeName,
                    })),
                  })
                )
              : Effect.fail(
                  refusal(
                    "That run belongs to another workflow. Pass a runId from list_runs."
                  )
                )
          )
        ),

      startTestRun: ({ payload, eventName }) =>
        serve(
          WfGraphOperations.workflowExecute,
          postWorkflowExecute(workflowId, {
            input: payload,
            eventName,
            graph: "draft",
          })
        ).pipe(
          Effect.map((started): StartedTestRun =>
            started.status === "running"
              ? { status: "started", runId: started.executionId }
              : { status: "ignored", reason: started.reason }
          )
        ),

      fieldOptions: ({ actionId, fieldKey, integrationId, parameters }) =>
        Effect.gen(function* () {
          const { catalog } = Context.get(services, Extensions);
          const action = findAction(catalog, actionId);
          const provider = flattenConfigFields(action?.configFields ?? []).find(
            (field) => field.key === fieldKey
          )?.optionsSource?.provider;
          if (action === undefined || provider === undefined) {
            return yield* Effect.fail(
              refusal(
                `${fieldKey} on ${actionId} has no options provider. Only a field describe_action marks with one has choices.`
              )
            );
          }
          if (action.integration && integrationId === undefined) {
            return yield* Effect.fail(
              refusal(
                `${actionId} is an integration action: pass the step's integrationId.`
              )
            );
          }
          const answer = yield* integrationId === undefined
            ? serve(
                WfGraphOperations.actionConfigOptions,
                postActionConfigOptions(actionId, provider, parameters)
              )
            : serve(
                WfGraphOperations.integrationConfigOptions,
                postIntegrationConfigOptions(integrationId, provider, {
                  ...parameters,
                })
              );
          if (answer.status === "options") {
            return { status: "options" as const, options: answer.options };
          }
          return {
            status: "unavailable" as const,
            message:
              answer.status === "unavailable"
                ? answer.message
                : "This field draws a set of inputs rather than a list of choices; set its keys from describe_action.",
          };
        }),
    };
    return operations;
  }
);
