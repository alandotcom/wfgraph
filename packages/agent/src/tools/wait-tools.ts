/**
 * Structured authoring for the Wait step's two modes.
 *
 * The tool replaces every Wait-owned config key as one unit. This keeps fields
 * from the previous mode out of the graph while preserving config owned by the
 * node itself.
 */

import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { findEvent } from "@wfgraph/shared/extensions/catalog";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { DEFAULT_WAIT_TIMEOUT } from "@wfgraph/shared/lifecycle/wait-subscription";
import { parseDurationMs } from "@wfgraph/shared/utils/wait-time";
import { WorkflowDraft } from "#src/document";

const failureSchema = Schema.Struct({ reason: Schema.String });
const writeResultSchema = Schema.Struct({ summary: Schema.String });

const waitForSchema = Schema.Array(
  Schema.Struct({
    event: Schema.String.annotate({
      description: "An Event name exactly as list_events returned it.",
    }),
  })
);

export const SetWait = Tool.make("set_wait", {
  description:
    "Configure a Wait step as a duration delay or an Event subscription. This replaces the Wait settings from its previous mode.",
  parameters: Schema.Struct({
    nodeId: Schema.String.annotate({
      description: "The Wait node to configure, from read_workflow.",
    }),
    mode: Schema.Literals(["delay", "event"]).annotate({
      description:
        "delay pauses for duration. event pauses for one of the waitFor Events.",
    }),
    duration: Schema.optionalKey(Schema.String).annotate({
      description:
        'How long delay mode pauses, such as "2d". Required in delay mode.',
    }),
    waitFor: Schema.optionalKey(waitForSchema).annotate({
      description:
        "One or more Event subscriptions from list_events. Required in event mode.",
    }),
    timeout: Schema.optionalKey(Schema.String).annotate({
      description:
        "How long Event mode waits before timing out. Defaults to 7d.",
    }),
    timeoutBehavior: Schema.optionalKey(
      Schema.Literals(["continue", "skip"])
    ).annotate({
      description:
        "What the run does after an Event timeout. continue resumes after the Wait; skip bypasses the path. Defaults to continue.",
    }),
  }),
  success: writeResultSchema,
  failure: failureSchema,
  failureMode: "return",
});

type SetWaitInput = {
  readonly nodeId: string;
  readonly mode: "delay" | "event";
  readonly duration?: string | undefined;
  readonly waitFor?:
    | readonly {
        readonly event: string;
      }[]
    | undefined;
  readonly timeout?: string | undefined;
  readonly timeoutBehavior?: "continue" | "skip" | undefined;
};

const WAIT_OWNED_KEYS = new Set([
  "waitMode",
  "waitFor",
  "waitTimeout",
  "waitTimeoutBehavior",
  "waitDuration",
  "waitUntil",
  "waitOffset",
  "waitDelayTimingMode",
  "waitGateMode",
  "waitAllowedHoursMode",
  "waitAllowedStartTime",
  "waitAllowedEndTime",
  "waitTimezone",
]);

function configOutsideWait(node: WorkflowNode): Record<string, unknown> {
  // oxlint-disable-next-line wfgraph/no-entries-round-trip -- node.data.config is stored JSON and can carry an own __proto__ key; Object.fromEntries defines it as an own property instead of reaching the prototype setter that key-by-key assignment would.
  return Object.fromEntries(
    Object.entries(node.data.config ?? {}).filter(
      ([key]) => !WAIT_OWNED_KEYS.has(key)
    )
  );
}

export const waitToolHandlers = Effect.gen(function* () {
  const draft = yield* WorkflowDraft;

  return {
    set_wait: (input: SetWaitInput) =>
      Effect.flatMap(draft.current, (document) => {
        const node = document.nodes.find(
          (candidate) => candidate.id === input.nodeId
        );
        if (!node) {
          return Effect.fail({
            reason: "That Wait step is absent from the graph.",
          });
        }
        if (actionTypeOf(node) !== BUILT_IN_ACTION_IDS.wait) {
          return Effect.fail({
            reason: `${node.data.label || node.id} is not a Wait step.`,
          });
        }

        const baseConfig = configOutsideWait(node);
        let waitConfig: Record<string, unknown>;
        if (input.mode === "delay") {
          if (parseDurationMs(input.duration) === null) {
            return Effect.fail({
              reason: "Delay mode needs a valid duration such as 2d or 48h.",
            });
          }
          waitConfig = {
            waitMode: "delay",
            waitDuration: input.duration,
          };
        } else {
          if (!input.waitFor || input.waitFor.length === 0) {
            return Effect.fail({
              reason: "Event mode needs at least one Event in waitFor.",
            });
          }
          if (
            input.waitFor.some(
              (subscription) =>
                findEvent(draft.catalog, subscription.event) === undefined
            )
          ) {
            return Effect.fail({
              reason:
                "A waitFor Event is absent from the host catalog. Call list_events and use an exact Event name.",
            });
          }
          if (
            input.timeout !== undefined &&
            parseDurationMs(input.timeout) === null
          ) {
            return Effect.fail({
              reason: "An Event wait timeout must be a valid duration.",
            });
          }
          waitConfig = {
            waitMode: "event",
            waitFor: input.waitFor.map((subscription) => ({
              event: subscription.event,
            })),
            waitTimeout: input.timeout ?? DEFAULT_WAIT_TIMEOUT,
            waitTimeoutBehavior: input.timeoutBehavior ?? "continue",
          };
        }

        const updated: WorkflowNode = {
          ...node,
          data: {
            ...node.data,
            config: { ...baseConfig, ...waitConfig },
          },
        };
        return Effect.as(
          draft.update((current) => ({
            ...current,
            nodes: current.nodes.map((candidate) =>
              candidate.id === input.nodeId ? updated : candidate
            ),
          })),
          {
            summary: `Set ${node.data.label || node.id} to wait by ${input.mode}.`,
          }
        );
      }),
  };
});
