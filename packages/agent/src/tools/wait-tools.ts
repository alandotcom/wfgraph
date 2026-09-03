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

const waitInputSchema = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("duration").annotate({
      description: "Wait for a duration measured from now.",
    }),
    duration: Schema.String.annotate({
      description: 'How long to wait, such as "2d".',
    }),
  }),
  Schema.Struct({
    mode: Schema.Literal("until").annotate({
      description: "Wait until an absolute date/time.",
    }),
    timestamp: Schema.String.annotate({
      description:
        "The exact timestamp token from list_references, or an ISO timestamp.",
    }),
    offset: Schema.optionalKey(Schema.String).annotate({
      description:
        'A duration added to the timestamp, such as "-1d" for one day before or "6h" for six hours after.',
    }),
    timezone: Schema.optionalKey(Schema.String).annotate({
      description:
        "The IANA timezone for an ISO timestamp with no UTC offset. Omit it for a timestamp reference or an ISO timestamp that includes an offset.",
    }),
  }),
  Schema.Struct({
    mode: Schema.Literal("event").annotate({
      description: "Wait until an Event arrives or the timeout expires.",
    }),
    events: waitForSchema.annotate({
      description:
        "At least one Event subscription. Call list_events first and use exact Event names.",
    }),
    timeout: Schema.optionalKey(Schema.String).annotate({
      description:
        'How long to wait for an Event, such as "7d". Defaults to the safe system timeout.',
    }),
    timeoutBehavior: Schema.optionalKey(
      Schema.Literals(["continue", "skip"])
    ).annotate({
      description:
        "What happens after the timeout. continue follows outgoing edges; skip ends this path. Defaults to continue.",
    }),
  }),
]).annotate({
  description: "The one Wait mode and the fields that mode requires.",
});

const setWaitInputSchema = Schema.Struct({
  nodeId: Schema.String.annotate({
    description: "The Wait node to configure, from read_workflow.",
  }),
  wait: waitInputSchema,
});

export const SetWait = Tool.make("set_wait", {
  description:
    "Configure a Wait step for a duration, until a date/time, or for an Event subscription. Use until timing when the request names a date/time from an earlier step, and call list_references first. This replaces the Wait settings from its previous mode.",
  parameters: setWaitInputSchema,
  success: writeResultSchema,
  failure: failureSchema,
  failureMode: "return",
});

type SetWaitInput = typeof setWaitInputSchema.Type;

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
        const wait = input.wait;
        let waitConfig: Record<string, unknown>;
        if (wait.mode === "duration") {
          if (parseDurationMs(wait.duration) === null) {
            return Effect.fail({
              reason: "A Wait needs a valid duration such as 2d or 48h.",
            });
          }
          waitConfig = {
            waitMode: "delay",
            waitDuration: wait.duration,
          };
        } else if (wait.mode === "until") {
          if (isBlank(wait.timestamp)) {
            return Effect.fail({
              reason:
                "Until timing needs a timestamp from list_references or an ISO timestamp.",
            });
          }

          const tokens = findTemplateTokens(wait.timestamp);
          if (tokens.length > 0) {
            const reference = referencesForNode({
              nodeId: input.nodeId,
              document,
              catalog: draft.catalog,
            })?.find((candidate) => candidate.token === wait.timestamp);
            if (reference?.type !== "timestamp") {
              return Effect.fail({
                reason:
                  "Until timing needs an exact timestamp token from list_references.",
              });
            }
          } else if (
            parseTimestampWithTimezone(wait.timestamp, wait.timezone) === null
          ) {
            return Effect.fail({
              reason:
                "Until timing needs an exact timestamp token from list_references or a valid ISO timestamp.",
            });
          }

          if (
            wait.offset !== undefined &&
            parseDurationMs(wait.offset) === null
          ) {
            return Effect.fail({
              reason:
                "An until offset must be a valid duration such as -1d or 6h.",
            });
          }
          waitConfig = {
            waitMode: "delay",
            waitDelayTimingMode: "until",
            waitUntil: wait.timestamp,
            ...omitUndefined({
              waitOffset: wait.offset,
              waitTimezone: wait.timezone,
            }),
          };
        } else {
          if (wait.events.length === 0) {
            return Effect.fail({
              reason: "Event mode needs at least one Event.",
            });
          }
          if (
            wait.events.some(
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
            wait.timeout !== undefined &&
            parseDurationMs(wait.timeout) === null
          ) {
            return Effect.fail({
              reason: "An Event wait timeout must be a valid duration.",
            });
          }
          waitConfig = {
            waitMode: "event",
            waitFor: wait.events.map((subscription) => ({
              event: subscription.event,
            })),
            waitTimeout: wait.timeout ?? DEFAULT_WAIT_TIMEOUT,
            waitTimeoutBehavior: wait.timeoutBehavior ?? "continue",
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
            summary: `Set ${node.data.label || node.id} to wait by ${wait.mode}.`,
          }
        );
      }),
  };
});
