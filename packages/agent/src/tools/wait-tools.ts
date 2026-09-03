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
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { DEFAULT_WAIT_TIMEOUT } from "@wfgraph/shared/lifecycle/wait-subscription";
import { isBlank } from "@wfgraph/shared/types/string";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  parseDurationMs,
  parseTimestampWithTimezone,
} from "@wfgraph/shared/utils/wait-time";
import { WorkflowDraft } from "#src/document";
import { referencesForNode } from "#src/tools/reference-tools";

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
    "Configure a Wait step for a duration, until a date/time, or for an Event subscription. Use until timing when the request names a date/time from an earlier step, and call list_references first. This replaces the Wait settings from its previous mode.",
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
        'How long duration timing pauses, such as "2d". Required when timing is duration.',
    }),
    timing: Schema.optionalKey(Schema.Literals(["duration", "until"])).annotate(
      {
        description:
          "How delay mode gets its target time. duration waits from now and is the default. until reads an absolute date/time, often from an upstream timestamp reference.",
      }
    ),
    until: Schema.optionalKey(Schema.String).annotate({
      description:
        "The date/time for until timing. Use the exact timestamp token from list_references, or an ISO timestamp.",
    }),
    offset: Schema.optionalKey(Schema.String).annotate({
      description:
        'A duration added to until, such as "-1d" for one day before or "6h" for six hours after.',
    }),
    timezone: Schema.optionalKey(Schema.String).annotate({
      description:
        "The IANA timezone for an until value that has no UTC offset. Omit it for timestamp references or ISO timestamps that include an offset.",
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
  readonly timing?: "duration" | "until" | undefined;
  readonly duration?: string | undefined;
  readonly until?: string | undefined;
  readonly offset?: string | undefined;
  readonly timezone?: string | undefined;
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
  // oxlint-disable-next-line wfgraph/no-entries-round-trip -- node.data.config is stored JSON and can carry an own __proto__ key. Object.fromEntries defines that key as an own property; key-by-key assignment would reach the prototype setter and lose it.
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
          const timing = input.timing ?? "duration";
          if (timing === "duration") {
            if (parseDurationMs(input.duration) === null) {
              return Effect.fail({
                reason:
                  "Duration timing needs a valid duration such as 2d or 48h.",
              });
            }
            waitConfig = {
              waitMode: "delay",
              waitDuration: input.duration,
            };
          } else {
            if (!input.until || isBlank(input.until)) {
              return Effect.fail({
                reason:
                  "Until timing needs a timestamp from list_references or an ISO timestamp.",
              });
            }

            const tokens = findTemplateTokens(input.until);
            if (tokens.length > 0) {
              const reference = referencesForNode({
                nodeId: input.nodeId,
                document,
                catalog: draft.catalog,
              })?.find((candidate) => candidate.token === input.until);
              if (reference?.type !== "timestamp") {
                return Effect.fail({
                  reason:
                    "Until timing needs an exact timestamp token from list_references.",
                });
              }
            } else if (
              parseTimestampWithTimezone(input.until, input.timezone) === null
            ) {
              return Effect.fail({
                reason:
                  "Until timing needs an exact timestamp token from list_references or a valid ISO timestamp.",
              });
            }

            if (
              input.offset !== undefined &&
              parseDurationMs(input.offset) === null
            ) {
              return Effect.fail({
                reason:
                  "An until offset must be a valid duration such as -1d or 6h.",
              });
            }
            waitConfig = {
              waitMode: "delay",
              waitDelayTimingMode: "until",
              waitUntil: input.until,
              ...omitUndefined({
                waitOffset: input.offset,
                waitTimezone: input.timezone,
              }),
            };
          }
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
